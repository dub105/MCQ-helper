import { useState, useEffect } from "react";

const DATA_KEY = "mcq_data_v2";
const OLD_QUESTIONS_KEY = "mcq_questions_v1";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Minimal wrapper matching the {value} shape used below, backed by localStorage.
const storage = {
  async get(key) {
    const value = localStorage.getItem(key);
    return value === null ? null : { value };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
  },
};

// ---- Image storage (IndexedDB) ---------------------------------------
// Photos/diagrams are stored as Blobs on-device so questions work fully offline.
const IMAGE_DB_NAME = "mcq_images_v1";
const IMAGE_STORE = "images";

function openImageDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMAGE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IMAGE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveImage(id, blob) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, "readwrite");
    tx.objectStore(IMAGE_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadImage(id) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, "readonly");
    const req = tx.objectStore(IMAGE_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteImage(id) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, "readwrite");
    tx.objectStore(IMAGE_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Resolves an imageId to a displayable object URL, revoking it on cleanup.
function StoredImage({ imageId, className, alt }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!imageId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl = null;
    loadImage(imageId).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId]);

  if (!url) return null;
  return <img className={className} src={url} alt={alt || ""} />;
}

const SAMPLE_TEXT = `Q: 心筋梗塞の心電図所見で最も特徴的なのはどれか
A) ST上昇
B) PR延長
C) QT短縮
D) P波消失
Answer: A

Q: 房室ブロックのうち治療を要さないことが多いのはどれか
A) I度房室ブロック
B) II度房室ブロック Mobitz II型
C) III度房室ブロック
D) 完全房室解離
Answer: A`;

// ---- Bulk text parsing -----------------------------------------------
// Blocks separated by blank lines. Each block:
//   Q: 問題文...           (prefix Q: / 問題: / 問: optional)
//   A) 選択肢1             (letter or number, followed by ) . 、)
//   ...
//   Answer: A              (Answer: / 答え: / 正解:  letter or number)
function parseBulkText(text) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const results = [];
  const errors = [];

  blocks.forEach((block, blockIdx) => {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 3) {
      errors.push(`ブロック${blockIdx + 1}: 行数が足りません`);
      return;
    }

    let questionText = null;
    const choices = [];
    let answerRaw = null;

    lines.forEach((line) => {
      const qMatch = line.match(/^(?:Q|問題|問)\s*[:：]\s*(.+)$/i);
      const choiceMatch = line.match(/^([A-Za-z0-9])\s*[).、.]\s*(.+)$/);
      const answerMatch = line.match(/^(?:Answer|答え|正解)\s*[:：]\s*([A-Za-z0-9]+)/i);

      if (answerMatch) {
        answerRaw = answerMatch[1];
      } else if (qMatch) {
        questionText = qMatch[1].trim();
      } else if (choiceMatch) {
        choices.push({ label: choiceMatch[1].toUpperCase(), text: choiceMatch[2].trim() });
      } else if (questionText === null) {
        questionText = line;
      }
    });

    if (!questionText || choices.length < 2 || !answerRaw) {
      errors.push(`ブロック${blockIdx + 1}: 問題文・選択肢・正解のいずれかが読み取れません`);
      return;
    }

    let correctIndex = -1;
    const answerUpper = answerRaw.toUpperCase();
    const byLabel = choices.findIndex((c) => c.label === answerUpper);
    if (byLabel !== -1) {
      correctIndex = byLabel;
    } else if (/^\d+$/.test(answerRaw)) {
      const n = parseInt(answerRaw, 10);
      if (n >= 1 && n <= choices.length) correctIndex = n - 1;
    }

    if (correctIndex === -1) {
      errors.push(`ブロック${blockIdx + 1}: 正解「${answerRaw}」が選択肢と一致しません`);
      return;
    }

    results.push({
      id: uid(),
      question: questionText,
      choices: choices.map((c) => c.text),
      correct: correctIndex,
    });
  });

  return { results, errors };
}

// ---- Shared ----------------------------------------------------------
function TopBar({ title, onBack }) {
  return (
    <div className="topbar">
      {onBack ? (
        <button className="backBtn" onClick={onBack} aria-label="戻る">
          ←
        </button>
      ) : (
        <span className="backBtn placeholder" />
      )}
      <h1>{title}</h1>
      <span className="backBtn placeholder" />
    </div>
  );
}

// ---- Home: folder list --------------------------------------------------
function Home({
  folders,
  questions,
  onOpenFolder,
  onCreateFolder,
  onPracticeAll,
  onPracticeFlagged,
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const totalCount = questions.length;
  const flaggedCount = questions.filter((q) => q.flagged).length;

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreateFolder(trimmed);
    setName("");
    setAdding(false);
  }

  return (
    <div className="screen">
      <TopBar title="一問一答" />

      <div className="hero">
        <div className="heroNumber">{totalCount}</div>
        <div className="heroLabel">
          全フォルダ合計の問題数{folders.length > 0 ? `・${folders.length}フォルダ` : ""}
        </div>
        {totalCount > 0 && (
          <button className="linkBtn" onClick={onPracticeAll}>
            すべての問題で演習する
          </button>
        )}
        {flaggedCount > 0 && (
          <button className="linkBtn" onClick={onPracticeFlagged}>
            チェックした問題を演習する（{flaggedCount}）
          </button>
        )}
      </div>

      <div className="listHeader">
        <h2>フォルダ（科目）</h2>
      </div>

      {folders.length === 0 && !adding && (
        <p className="emptyNote">
          まだフォルダがありません。科目ごとにフォルダを作って問題を整理しましょう。
        </p>
      )}

      <div className="menuList">
        {folders.map((f) => {
          const count = questions.filter((q) => q.folderId === f.id).length;
          return (
            <button className="menuCard" key={f.id} onClick={() => onOpenFolder(f.id)}>
              <span className="menuCardTitle">{f.name}</span>
              <span className="menuCardSub">{count}問</span>
            </button>
          );
        })}
      </div>

      {adding ? (
        <div className="card" style={{ marginTop: 12 }}>
          <label className="fieldLabel">フォルダ名</label>
          <input
            className="textInput"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例）循環器学"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <div className="formActions">
            <button className="primaryBtn" onClick={submit}>
              作成する
            </button>
            <button
              className="ghostBtn"
              onClick={() => {
                setAdding(false);
                setName("");
              }}
            >
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        <button className="addFolderBtn" onClick={() => setAdding(true)}>
          ＋ 新しいフォルダを作成
        </button>
      )}
    </div>
  );
}

// ---- Folder home: choose 演習 / 管理, rename / delete -------------------
function FolderHome({
  folder,
  questionCount,
  flaggedCount,
  onBack,
  onGoManage,
  onGoPractice,
  onGoPracticeFlagged,
  onRename,
  onDelete,
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder.name);

  return (
    <div className="screen">
      <TopBar title={folder.name} onBack={onBack} />
      <div className="hero">
        <div className="heroNumber">{questionCount}</div>
        <div className="heroLabel">このフォルダの問題数</div>
      </div>
      <div className="menuList">
        <button className="menuCard primary" onClick={onGoPractice} disabled={questionCount === 0}>
          <span className="menuCardTitle">演習する</span>
          <span className="menuCardSub">
            {questionCount === 0 ? "先に問題を登録してください" : "選択肢を選んで採点"}
          </span>
        </button>
        <button className="menuCard" onClick={onGoManage}>
          <span className="menuCardTitle">問題を管理</span>
          <span className="menuCardSub">登録・編集・削除、一括登録</span>
        </button>
        {flaggedCount > 0 && (
          <button className="menuCard" onClick={onGoPracticeFlagged}>
            <span className="menuCardTitle">チェックした問題を演習</span>
            <span className="menuCardSub">{flaggedCount}問</span>
          </button>
        )}
      </div>

      <div className="folderTools">
        {renaming ? (
          <div className="card">
            <label className="fieldLabel">フォルダ名</label>
            <input
              className="textInput"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <div className="formActions">
              <button
                className="primaryBtn"
                onClick={() => {
                  if (name.trim()) onRename(name.trim());
                  setRenaming(false);
                }}
              >
                保存
              </button>
              <button className="ghostBtn" onClick={() => setRenaming(false)}>
                キャンセル
              </button>
            </div>
          </div>
        ) : (
          <div className="toolLinks">
            <button className="linkBtn" onClick={() => setRenaming(true)}>
              フォルダ名を変更
            </button>
            <button className="linkBtn dangerText" onClick={onDelete}>
              フォルダを削除
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Manage (scoped to one folder, or "all" view-only move support) -----
function ManageView({
  folder,
  folders,
  questions,
  onBack,
  onAddOrUpdate,
  onDelete,
  onBulkAdd,
  onClearAll,
  onToggleFlag,
}) {
  const [tab, setTab] = useState("form");
  const [editingId, setEditingId] = useState(null);
  const [qText, setQText] = useState("");
  const [choices, setChoices] = useState(["", ""]);
  const [correct, setCorrect] = useState(0);
  const [moveFolderId, setMoveFolderId] = useState(folder.id);
  const [imageId, setImageId] = useState(null);
  // The image the persisted question had when editing began, so cancelling
  // an edit never deletes an image that's still in use elsewhere.
  const [originalImageId, setOriginalImageId] = useState(null);

  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState(null);

  function resetForm() {
    setEditingId(null);
    setQText("");
    setChoices(["", ""]);
    setCorrect(0);
    setMoveFolderId(folder.id);
    setImageId(null);
    setOriginalImageId(null);
  }

  function cancelEdit() {
    if (imageId && imageId !== originalImageId) {
      deleteImage(imageId);
    }
    resetForm();
  }

  function startEdit(q) {
    setTab("form");
    setEditingId(q.id);
    setQText(q.question);
    setChoices([...q.choices]);
    setCorrect(q.correct);
    setMoveFolderId(q.folderId);
    setImageId(q.imageId || null);
    setOriginalImageId(q.imageId || null);
  }

  async function handleImageSelect(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const id = uid();
    await saveImage(id, file);
    setImageId(id);
  }

  async function handleRemoveImage() {
    if (imageId && imageId !== originalImageId) {
      await deleteImage(imageId);
    }
    setImageId(null);
  }

  function handleChoiceChange(i, val) {
    const next = [...choices];
    next[i] = val;
    setChoices(next);
  }

  function addChoice() {
    if (choices.length >= LETTERS.length) return;
    setChoices([...choices, ""]);
  }

  function removeChoice(i) {
    if (choices.length <= 2) return;
    const next = choices.filter((_, idx) => idx !== i);
    setChoices(next);
    if (correct === i) setCorrect(0);
    else if (correct > i) setCorrect(correct - 1);
  }

  function submitForm() {
    const trimmedChoices = choices.map((c) => c.trim());
    if (!qText.trim() || trimmedChoices.some((c) => !c)) {
      alert("問題文とすべての選択肢を入力してください");
      return;
    }
    if (editingId && originalImageId && originalImageId !== imageId) {
      deleteImage(originalImageId);
    }
    onAddOrUpdate({
      id: editingId || uid(),
      question: qText.trim(),
      choices: trimmedChoices,
      correct,
      folderId: editingId ? moveFolderId : folder.id,
      imageId,
    });
    resetForm();
  }

  function insertSample() {
    setBulkText(SAMPLE_TEXT);
    setBulkResult(null);
  }

  function runBulkParse() {
    const { results, errors } = parseBulkText(bulkText);
    setBulkResult({ results, errors });
  }

  function commitBulk() {
    if (!bulkResult || bulkResult.results.length === 0) return;
    const withFolder = bulkResult.results.map((r) => ({ ...r, folderId: folder.id }));
    onBulkAdd(withFolder);
    setBulkText("");
    setBulkResult(null);
  }

  return (
    <div className="screen">
      <TopBar title={`${folder.name}の問題`} onBack={onBack} />

      <div className="tabRow">
        <button className={"tabBtn" + (tab === "form" ? " active" : "")} onClick={() => setTab("form")}>
          手動で登録
        </button>
        <button className={"tabBtn" + (tab === "bulk" ? " active" : "")} onClick={() => setTab("bulk")}>
          テキストで一括登録
        </button>
      </div>

      {tab === "form" && (
        <div className="card">
          {editingId && <div className="editNotice">編集中の問題を更新します</div>}
          <label className="fieldLabel">問題文</label>
          <textarea
            className="textInput"
            rows={3}
            value={qText}
            onChange={(e) => setQText(e.target.value)}
            placeholder="例）心筋梗塞の心電図所見で最も特徴的なのはどれか"
          />

          <label className="fieldLabel">画像（任意）</label>
          {imageId ? (
            <div className="imagePreviewWrap">
              <StoredImage imageId={imageId} className="imagePreview" alt="登録した画像" />
              <button className="ghostBtn" onClick={handleRemoveImage}>
                画像を削除
              </button>
            </div>
          ) : (
            <input className="fileInput" type="file" accept="image/*" onChange={handleImageSelect} />
          )}

          <label className="fieldLabel">選択肢（正解をタップして選択）</label>
          {choices.map((c, i) => (
            <div className="choiceRow" key={i}>
              <button
                className={"letterPick" + (correct === i ? " correctPick" : "")}
                onClick={() => setCorrect(i)}
                aria-label={`${LETTERS[i]}を正解にする`}
              >
                {LETTERS[i]}
              </button>
              <input
                className="textInput"
                value={c}
                onChange={(e) => handleChoiceChange(i, e.target.value)}
                placeholder={`選択肢 ${LETTERS[i]}`}
              />
              {choices.length > 2 && (
                <button className="removeChoiceBtn" onClick={() => removeChoice(i)}>
                  ×
                </button>
              )}
            </div>
          ))}
          {choices.length < LETTERS.length && (
            <button className="addChoiceBtn" onClick={addChoice}>
              ＋ 選択肢を追加
            </button>
          )}

          {editingId && folders.length > 1 && (
            <>
              <label className="fieldLabel">フォルダ</label>
              <select
                className="textInput"
                value={moveFolderId}
                onChange={(e) => setMoveFolderId(e.target.value)}
              >
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </>
          )}

          <div className="formActions">
            <button className="primaryBtn" onClick={submitForm}>
              {editingId ? "更新する" : "登録する"}
            </button>
            {editingId && (
              <button className="ghostBtn" onClick={cancelEdit}>
                キャンセル
              </button>
            )}
          </div>
        </div>
      )}

      {tab === "bulk" && (
        <div className="card">
          <p className="hint">
            以下の形式でまとめて貼り付けると、複数問を一度に登録できます。問題ごとに空行で区切ってください。
          </p>
          <pre className="formatExample">{`Q: 問題文をここに
A) 選択肢1
B) 選択肢2
C) 選択肢3
D) 選択肢4
Answer: B

Q: 次の問題文
A) ...
B) ...
Answer: A`}</pre>
          <button className="ghostBtn" onClick={insertSample} style={{ marginBottom: 12 }}>
            サンプルを試す
          </button>
          <label className="fieldLabel">貼り付けテキスト</label>
          <textarea
            className="textInput"
            rows={10}
            value={bulkText}
            onChange={(e) => {
              setBulkText(e.target.value);
              setBulkResult(null);
            }}
            placeholder="ここに問題を貼り付け"
          />
          <div className="formActions">
            <button className="primaryBtn" onClick={runBulkParse} disabled={!bulkText.trim()}>
              内容を確認する
            </button>
          </div>

          {bulkResult && (
            <div className="bulkPreview">
              <div className="bulkSummary">
                読み取り成功: {bulkResult.results.length}問
                {bulkResult.errors.length > 0 && `／エラー: ${bulkResult.errors.length}件`}
              </div>
              {bulkResult.errors.map((e, i) => (
                <div className="bulkError" key={i}>
                  {e}
                </div>
              ))}
              {bulkResult.results.map((r, i) => (
                <div className="bulkItem" key={r.id}>
                  <div className="bulkItemQ">
                    {i + 1}. {r.question}
                  </div>
                  <div className="bulkItemA">
                    正解: {LETTERS[r.correct]}) {r.choices[r.correct]}
                  </div>
                </div>
              ))}
              {bulkResult.results.length > 0 && (
                <button className="primaryBtn" onClick={commitBulk}>
                  {folder.name}に登録する（{bulkResult.results.length}問）
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="listHeader">
        <h2>登録済みの問題（{questions.length}）</h2>
        {questions.length > 0 && (
          <button className="dangerLinkBtn" onClick={onClearAll}>
            このフォルダを全削除
          </button>
        )}
      </div>

      {questions.length === 0 ? (
        <p className="emptyNote">まだ問題がありません。上のフォームから登録してください。</p>
      ) : (
        <div className="qList">
          {questions.map((q) => (
            <div className="qItem" key={q.id}>
              {q.imageId && <StoredImage imageId={q.imageId} className="qItemThumb" alt="問題画像" />}
              <div className="qItemMain">
                <div className="qItemText">{q.question}</div>
                <div className="qItemMeta">
                  正解: {LETTERS[q.correct]}) {q.choices[q.correct]}
                </div>
              </div>
              <div className="qItemActions">
                <button
                  className={"smallBtn starBtn" + (q.flagged ? " starActive" : "")}
                  onClick={() => onToggleFlag(q.id)}
                  aria-label="チェックを切り替え"
                >
                  {q.flagged ? "★ チェック" : "☆ チェック"}
                </button>
                <button className="smallBtn" onClick={() => startEdit(q)}>
                  編集
                </button>
                <button className="smallBtn dangerText" onClick={() => onDelete(q.id)}>
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Practice setup (shuffle only; scope already chosen) -----------------
function PracticeSetup({ scopeName, count, onBack, onStart }) {
  const [shuffle, setShuffle] = useState(true);

  return (
    <div className="screen">
      <TopBar title="演習の設定" onBack={onBack} />
      <div className="card">
        <div className="fieldLabel">出題範囲</div>
        <div className="scopeNote">{scopeName}（{count}問）</div>

        <label className="fieldLabel">出題順</label>
        <div className="toggleRow">
          <button className={"toggleOpt" + (shuffle ? " toggleActive" : "")} onClick={() => setShuffle(true)}>
            シャッフル
          </button>
          <button className={"toggleOpt" + (!shuffle ? " toggleActive" : "")} onClick={() => setShuffle(false)}>
            登録順
          </button>
        </div>

        <button className="primaryBtn wide" disabled={count === 0} onClick={() => onStart(shuffle)}>
          {count}問で開始する
        </button>
      </div>
    </div>
  );
}

// ---- Practice ---------------------------------------------------------------
function Practice({ deck, folderNameOf, onBack, onFinish }) {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answers, setAnswers] = useState([]);

  const current = deck[index];
  const isLast = index === deck.length - 1;

  function handleSelect(choiceIdx) {
    if (selected !== null) return;
    setSelected(choiceIdx);
  }

  function handleNext() {
    const record = {
      questionId: current.id,
      question: current.question,
      choices: current.choices,
      correctIndex: current.correct,
      selectedIndex: selected,
      isCorrect: selected === current.correct,
      imageId: current.imageId,
    };
    const nextAnswers = [...answers, record];
    if (isLast) {
      onFinish(nextAnswers);
    } else {
      setAnswers(nextAnswers);
      setSelected(null);
      setIndex(index + 1);
    }
  }

  return (
    <div className="screen">
      <TopBar title={`演習中 (${index + 1}/${deck.length})`} onBack={onBack} />
      <div className="progressTrack">
        <div
          className="progressFill"
          style={{ width: `${((index + (selected !== null ? 1 : 0)) / deck.length) * 100}%` }}
        />
      </div>
      <div className="card">
        {folderNameOf && <div className="qCategoryTag">{folderNameOf(current)}</div>}
        {current.imageId && <StoredImage imageId={current.imageId} className="questionImage" alt="問題画像" />}
        <div className="questionText">{current.question}</div>
        <div className="choicesList">
          {current.choices.map((c, i) => {
            let cls = "choiceBtn";
            if (selected !== null) {
              if (i === current.correct) cls += " choiceCorrect";
              else if (i === selected) cls += " choiceWrong";
              else cls += " choiceMuted";
            }
            return (
              <button key={i} className={cls} onClick={() => handleSelect(i)}>
                <span className="choiceLetter">{LETTERS[i]}</span>
                <span>{c}</span>
              </button>
            );
          })}
        </div>
        {selected !== null && (
          <div className={"feedback" + (selected === current.correct ? " feedbackGood" : " feedbackBad")}>
            {selected === current.correct ? "正解です" : `不正解 — 正解は ${LETTERS[current.correct]}`}
          </div>
        )}
        <button className="primaryBtn wide" disabled={selected === null} onClick={handleNext}>
          {isLast ? "結果を見る" : "次の問題へ"}
        </button>
      </div>
    </div>
  );
}

// ---- Results ------------------------------------------------------------------
function Results({ answers, questions, onRetrySame, onReviewWrong, onFlagWrong, onToggleFlag, onBackHome }) {
  const correctCount = answers.filter((a) => a.isCorrect).length;
  const total = answers.length;
  const pct = total > 0 ? Math.round((correctCount / total) * 100) : 0;
  const wrongOnes = answers.filter((a) => !a.isCorrect);

  return (
    <div className="screen">
      <TopBar title="結果" />
      <div className="hero">
        <div className="heroNumber">
          {correctCount}
          <span className="heroNumberSub">/{total}</span>
        </div>
        <div className="heroLabel">正答率 {pct}%</div>
      </div>

      <div className="formActions">
        <button className="primaryBtn" onClick={onRetrySame}>
          同じ範囲でもう一度
        </button>
        <button className="ghostBtn" onClick={onBackHome}>
          ホームに戻る
        </button>
      </div>

      {wrongOnes.length > 0 && (
        <>
          <div className="formActions">
            <button className="primaryBtn" onClick={() => onReviewWrong(wrongOnes)}>
              間違えた問題だけ復習する
            </button>
            <button
              className="ghostBtn"
              onClick={() => onFlagWrong(wrongOnes.map((a) => a.questionId))}
            >
              間違えた問題にすべてチェックを付ける
            </button>
          </div>
          <h2 className="sectionTitle">間違えた問題（{wrongOnes.length}）</h2>
          <div className="qList">
            {wrongOnes.map((a, i) => {
              const original = questions.find((q) => q.id === a.questionId);
              const flagged = original ? original.flagged : false;
              return (
                <div className="qItem reviewItem" key={i}>
                  {a.imageId && <StoredImage imageId={a.imageId} className="qItemThumb" alt="問題画像" />}
                  <div className="qItemMain">
                    <div className="qItemText">{a.question}</div>
                    <div className="qItemMeta wrongMeta">
                      あなたの回答: {LETTERS[a.selectedIndex]}) {a.choices[a.selectedIndex]}
                    </div>
                    <div className="qItemMeta correctMeta">
                      正解: {LETTERS[a.correctIndex]}) {a.choices[a.correctIndex]}
                    </div>
                  </div>
                  <div className="qItemActions">
                    <button
                      className={"smallBtn starBtn" + (flagged ? " starActive" : "")}
                      onClick={() => onToggleFlag(a.questionId)}
                    >
                      {flagged ? "★" : "☆"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---- App root ------------------------------------------------------------------
export default function App() {
  const [folders, setFolders] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const [view, setView] = useState("home");
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [practiceScope, setPracticeScope] = useState(null); // { name, folderId | null }
  const [deck, setDeck] = useState([]);
  const [lastAnswers, setLastAnswers] = useState([]);
  const [lastShuffle, setLastShuffle] = useState(true);
  const [lastPool, setLastPool] = useState([]);
  const [lastScope, setLastScope] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(DATA_KEY);
        if (res && res.value) {
          const data = JSON.parse(res.value);
          setFolders(data.folders || []);
          setQuestions(data.questions || []);
          setLoaded(true);
          return;
        }
      } catch (e) {
        // fall through to migration
      }
      // Migrate from the older single-key question list, if present
      try {
        const old = await storage.get(OLD_QUESTIONS_KEY);
        if (old && old.value) {
          const oldQuestions = JSON.parse(old.value);
          const catNames = Array.from(
            new Set(oldQuestions.map((q) => (q.category || "").trim() || "未分類"))
          );
          const newFolders = catNames.map((n) => ({ id: uid(), name: n }));
          const nameToId = {};
          newFolders.forEach((f) => (nameToId[f.name] = f.id));
          const newQuestions = oldQuestions.map((q) => ({
            id: q.id,
            question: q.question,
            choices: q.choices,
            correct: q.correct,
            folderId: nameToId[(q.category || "").trim() || "未分類"],
          }));
          setFolders(newFolders);
          setQuestions(newQuestions);
        }
      } catch (e) {
        // no old data either — start fresh
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        await storage.set(DATA_KEY, JSON.stringify({ folders, questions }));
      } catch (e) {
        console.error("保存に失敗しました", e);
      }
    })();
  }, [folders, questions, loaded]);

  function createFolder(name) {
    setFolders((prev) => [...prev, { id: uid(), name }]);
  }

  function renameFolder(id, name) {
    setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
  }

  function deleteFolder(id) {
    const inFolder = questions.filter((q) => q.folderId === id);
    const folder = folders.find((f) => f.id === id);
    if (
      !confirm(
        `「${folder ? folder.name : "このフォルダ"}」を削除します。中の問題${inFolder.length}問も削除されます。よろしいですか？`
      )
    )
      return;
    inFolder.forEach((q) => q.imageId && deleteImage(q.imageId));
    setFolders((prev) => prev.filter((f) => f.id !== id));
    setQuestions((prev) => prev.filter((q) => q.folderId !== id));
    setView("home");
  }

  function addOrUpdateQuestion(q) {
    setQuestions((prev) => {
      const exists = prev.some((p) => p.id === q.id);
      if (exists) return prev.map((p) => (p.id === q.id ? q : p));
      return [...prev, q];
    });
  }

  function deleteQuestion(id) {
    if (!confirm("この問題を削除しますか？")) return;
    const target = questions.find((q) => q.id === id);
    if (target && target.imageId) deleteImage(target.imageId);
    setQuestions((prev) => prev.filter((p) => p.id !== id));
  }

  function bulkAddQuestions(list) {
    setQuestions((prev) => [...prev, ...list]);
  }

  function clearFolderQuestions(folderId) {
    if (!confirm("このフォルダの問題をすべて削除します。よろしいですか？")) return;
    questions.filter((q) => q.folderId === folderId).forEach((q) => q.imageId && deleteImage(q.imageId));
    setQuestions((prev) => prev.filter((q) => q.folderId !== folderId));
  }

  function toggleFlag(id) {
    setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, flagged: !q.flagged } : q)));
  }

  function flagQuestions(ids) {
    const idSet = new Set(ids);
    setQuestions((prev) => prev.map((q) => (idSet.has(q.id) ? { ...q, flagged: true } : q)));
  }

  function startPracticeFromSetup(shuffle) {
    let d = [...lastPool];
    if (shuffle) {
      for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
      }
    }
    setDeck(d);
    setLastShuffle(shuffle);
    setView("practice");
  }

  function beginPracticeSetup(pool, name, scope) {
    setLastPool(pool);
    setLastScope(scope);
    setPracticeScope({ name, count: pool.length });
    setView("setup");
  }

  function openFolderPractice(folderId) {
    const pool = questions.filter((q) => q.folderId === folderId);
    const folder = folders.find((f) => f.id === folderId);
    beginPracticeSetup(pool, folder ? folder.name : "", { type: "folder", folderId });
  }

  function openAllPractice() {
    beginPracticeSetup(questions, "すべての問題", { type: "all" });
  }

  function openFlaggedPractice() {
    const pool = questions.filter((q) => q.flagged);
    beginPracticeSetup(pool, "チェックした問題", { type: "flagged" });
  }

  function openFolderFlaggedPractice(folderId) {
    const folder = folders.find((f) => f.id === folderId);
    const pool = questions.filter((q) => q.folderId === folderId && q.flagged);
    beginPracticeSetup(pool, `${folder ? folder.name : ""}・チェック済み`, {
      type: "flaggedFolder",
      folderId,
    });
  }

  function reviewWrongQuestions(wrongAnswers) {
    const pool = wrongAnswers.map((a) => {
      const original = questions.find((q) => q.id === a.questionId);
      return {
        id: a.questionId,
        question: a.question,
        choices: a.choices,
        correct: a.correctIndex,
        folderId: original ? original.folderId : null,
        imageId: original ? original.imageId : a.imageId,
      };
    });
    beginPracticeSetup(pool, "間違えた問題", { type: "wrong" });
  }

  function retrySameScope() {
    beginPracticeSetup(lastPool, practiceScope ? practiceScope.name : "", lastScope);
  }

  function finishPractice(answers) {
    setLastAnswers(answers);
    setView("results");
  }

  function folderNameOfQuestion(q) {
    const f = folders.find((ff) => ff.id === q.folderId);
    return f ? f.name : "";
  }

  const activeFolder = folders.find((f) => f.id === activeFolderId) || null;
  const activeFolderQuestions = activeFolder
    ? questions.filter((q) => q.folderId === activeFolder.id)
    : [];

  return (
    <div className="app">
      <style>{CSS}</style>

      {view === "home" && (
        <Home
          folders={folders}
          questions={questions}
          onOpenFolder={(id) => {
            setActiveFolderId(id);
            setView("folderHome");
          }}
          onCreateFolder={createFolder}
          onPracticeAll={openAllPractice}
          onPracticeFlagged={openFlaggedPractice}
        />
      )}

      {view === "folderHome" && activeFolder && (
        <FolderHome
          folder={activeFolder}
          questionCount={activeFolderQuestions.length}
          flaggedCount={activeFolderQuestions.filter((q) => q.flagged).length}
          onBack={() => setView("home")}
          onGoManage={() => setView("manage")}
          onGoPractice={() => openFolderPractice(activeFolder.id)}
          onGoPracticeFlagged={() => openFolderFlaggedPractice(activeFolder.id)}
          onRename={(name) => renameFolder(activeFolder.id, name)}
          onDelete={() => deleteFolder(activeFolder.id)}
        />
      )}

      {view === "manage" && activeFolder && (
        <ManageView
          folder={activeFolder}
          folders={folders}
          questions={activeFolderQuestions}
          onBack={() => setView("folderHome")}
          onAddOrUpdate={addOrUpdateQuestion}
          onDelete={deleteQuestion}
          onBulkAdd={bulkAddQuestions}
          onClearAll={() => clearFolderQuestions(activeFolder.id)}
          onToggleFlag={toggleFlag}
        />
      )}

      {view === "setup" && practiceScope && (
        <PracticeSetup
          scopeName={practiceScope.name}
          count={practiceScope.count}
          onBack={() => setView(activeFolder ? "folderHome" : "home")}
          onStart={startPracticeFromSetup}
        />
      )}

      {view === "practice" && (
        <Practice
          deck={deck}
          folderNameOf={
            lastScope && (lastScope.type === "all" || lastScope.type === "flagged" || lastScope.type === "wrong")
              ? folderNameOfQuestion
              : null
          }
          onBack={() => setView("home")}
          onFinish={finishPractice}
        />
      )}

      {view === "results" && (
        <Results
          answers={lastAnswers}
          questions={questions}
          onRetrySame={retrySameScope}
          onReviewWrong={reviewWrongQuestions}
          onFlagWrong={flagQuestions}
          onToggleFlag={toggleFlag}
          onBackHome={() => setView("home")}
        />
      )}
    </div>
  );
}

const CSS = `
:root {
  --bg: #10141c;
  --surface: #171d2b;
  --surface-2: #1f2740;
  --border: #2b3550;
  --text: #eef1f7;
  --text-dim: #93a0b8;
  --accent: #3b82f6;
  --accent-text: #ffffff;
  --highlight: #fbbf24;
  --highlight-text: #1a1408;
  --good: #3b82f6;
  --bad: #ef4444;
}
* { box-sizing: border-box; }
html, body { background: var(--bg); }
.app {
  font-family: "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", "Noto Sans JP", Meiryo, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  max-width: 480px;
  margin: 0 auto;
  padding-bottom: 32px;
  line-height: 1.6;
}
.screen { padding: 0 16px 16px; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 0 14px;
}
.topbar h1 {
  font-size: 19px;
  font-weight: 700;
  margin: 0;
  letter-spacing: 0.02em;
  text-align: center;
  flex: 1;
}
.backBtn {
  background: none;
  border: none;
  color: var(--text);
  font-size: 20px;
  width: 32px;
  height: 32px;
  cursor: pointer;
}
.backBtn.placeholder { visibility: hidden; }
.hero {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 28px 20px;
  text-align: center;
  margin-bottom: 16px;
}
.heroNumber {
  font-size: 44px;
  font-weight: 700;
  color: var(--accent);
  line-height: 1;
}
.heroNumberSub { font-size: 22px; color: var(--text-dim); font-weight: 400; }
.heroLabel { color: var(--text-dim); margin-top: 8px; font-size: 14px; }
.linkBtn {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 13px;
  margin-top: 12px;
  cursor: pointer;
  text-decoration: underline;
}
.linkBtn.dangerText { color: var(--bad); }
.menuList { display: flex; flex-direction: column; gap: 10px; }
.menuCard {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  text-align: left;
  color: var(--text);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.menuCard:disabled { opacity: 0.45; cursor: not-allowed; }
.menuCard.primary { border-color: var(--accent); }
.menuCardTitle { font-size: 16px; font-weight: 600; }
.menuCardSub { font-size: 13px; color: var(--text-dim); }
.addFolderBtn {
  width: 100%;
  margin-top: 12px;
  background: none;
  border: 1px dashed var(--border);
  color: var(--text-dim);
  border-radius: 12px;
  padding: 14px;
  font-size: 14px;
  cursor: pointer;
}
.folderTools { margin-top: 18px; }
.toolLinks { display: flex; gap: 18px; justify-content: center; }
.tabRow { display: flex; gap: 8px; margin-bottom: 14px; }
.tabBtn {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-dim);
  padding: 10px 8px;
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
}
.tabBtn.active { color: var(--accent-text); background: var(--accent); border-color: var(--accent); font-weight: 600; }
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 18px;
}
.fieldLabel { display: block; font-size: 12px; color: var(--text-dim); margin: 14px 0 6px; }
.fieldLabel:first-child { margin-top: 0; }
.scopeNote { font-size: 14px; margin-bottom: 4px; }
.textInput {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  resize: vertical;
}
.textInput:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.choiceRow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.choiceRow .textInput { flex: 1; }
.letterPick {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-dim);
  font-weight: 700;
  cursor: pointer;
}
.letterPick.correctPick { background: var(--good); border-color: var(--good); color: #ffffff; }
.removeChoiceBtn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.addChoiceBtn {
  background: none;
  border: 1px dashed var(--border);
  color: var(--text-dim);
  border-radius: 8px;
  padding: 8px;
  width: 100%;
  cursor: pointer;
  font-size: 13px;
}
.formActions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.primaryBtn {
  background: var(--accent);
  color: var(--accent-text);
  border: none;
  border-radius: 10px;
  padding: 12px 18px;
  font-weight: 700;
  font-size: 14px;
  cursor: pointer;
}
.primaryBtn:disabled { opacity: 0.4; cursor: not-allowed; }
.primaryBtn.wide { width: 100%; margin-top: 16px; }
.ghostBtn {
  background: none;
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 10px;
  padding: 12px 18px;
  font-size: 14px;
  cursor: pointer;
}
.editNotice { color: var(--accent); font-size: 13px; margin-bottom: 6px; }
.fileInput { width: 100%; font-size: 13px; color: var(--text-dim); margin-bottom: 4px; }
.imagePreviewWrap { margin-bottom: 4px; }
.imagePreview {
  display: block;
  width: 100%;
  height: auto;
  max-height: 220px;
  border-radius: 10px;
  border: 1px solid var(--border);
  margin-bottom: 8px;
  object-fit: contain;
  background: var(--surface-2);
}
.hint { color: var(--text-dim); font-size: 13px; margin: 0 0 10px; line-height: 1.6; }
.formatExample {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-dim);
  overflow-x: auto;
  white-space: pre;
  margin: 0 0 12px;
}
.bulkPreview { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 12px; }
.bulkSummary { font-size: 13px; color: var(--text-dim); margin-bottom: 8px; }
.bulkError { color: var(--bad); font-size: 12px; margin-bottom: 4px; }
.bulkItem { background: var(--surface-2); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; }
.bulkItemQ { font-size: 13px; margin-bottom: 2px; }
.bulkItemA { font-size: 12px; color: var(--good); }
.listHeader { display: flex; align-items: baseline; justify-content: space-between; margin: 10px 0 8px; }
.listHeader h2 { font-size: 15px; margin: 0; }
.sectionTitle { font-size: 15px; margin: 20px 0 10px; }
.dangerLinkBtn { background: none; border: none; color: var(--bad); font-size: 12px; cursor: pointer; }
.emptyNote { color: var(--text-dim); font-size: 13px; text-align: center; padding: 20px 0; }
.qList { display: flex; flex-direction: column; gap: 8px; }
.qItem {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.qItemThumb {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 8px;
  border: 1px solid var(--border);
  object-fit: cover;
}
.qItemMain { flex: 1; min-width: 0; }
.qItemText { font-size: 13px; margin-bottom: 4px; line-height: 1.5; }
.qItemMeta { font-size: 11px; color: var(--text-dim); }
.qItemMeta.wrongMeta { color: var(--bad); }
.qItemMeta.correctMeta { color: var(--good); }
.qItemActions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.smallBtn {
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 11px;
  cursor: pointer;
}
.smallBtn.dangerText { color: var(--bad); }
.smallBtn.starBtn.starActive { background: var(--highlight); border-color: var(--highlight); color: var(--highlight-text); font-weight: 600; }
.toggleRow { display: flex; gap: 8px; }
.toggleOpt {
  flex: 1;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  border-radius: 8px;
  padding: 10px;
  font-size: 13px;
  cursor: pointer;
}
.toggleOpt.toggleActive { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.progressTrack { height: 4px; background: var(--surface-2); border-radius: 2px; overflow: hidden; margin-bottom: 14px; }
.progressFill { height: 100%; background: var(--accent); transition: width 0.2s ease; }
.qCategoryTag {
  display: inline-block;
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
  margin-bottom: 10px;
}
.questionImage {
  display: block;
  width: 100%;
  height: auto;
  max-height: 320px;
  border-radius: 10px;
  border: 1px solid var(--border);
  margin-bottom: 14px;
  object-fit: contain;
  background: var(--surface-2);
}
.questionText { font-size: 17px; font-weight: 600; line-height: 1.8; margin-bottom: 18px; }
.choicesList { display: flex; flex-direction: column; gap: 8px; }
.choiceBtn {
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 10px;
  padding: 12px;
  font-size: 14px;
  cursor: pointer;
  line-height: 1.5;
}
.choiceLetter {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 12px;
}
.choiceBtn.choiceCorrect { border-color: var(--good); background: rgba(59, 130, 246, 0.15); }
.choiceBtn.choiceWrong { border-color: var(--bad); background: rgba(239, 68, 68, 0.15); }
.choiceBtn.choiceMuted { opacity: 0.5; }
.feedback { margin-top: 14px; font-size: 14px; font-weight: 600; }
.feedback.feedbackGood { color: var(--good); }
.feedback.feedbackBad { color: var(--bad); }
.reviewItem { align-items: flex-start; }

/* Tablet: wider canvas + multi-column lists instead of a stretched phone column */
@media (min-width: 700px) {
  .app { max-width: 760px; font-size: 17px; }
  .screen { padding: 0 24px 24px; }
  .topbar h1 { font-size: 21px; }
  .heroNumber { font-size: 52px; }
  .menuList { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .qList { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .questionText { font-size: 19px; }
  .questionImage { max-height: 420px; }
  .choiceBtn { padding: 14px 16px; font-size: 15px; }
  .card { max-width: 640px; margin-left: auto; margin-right: auto; }
}

/* Larger tablet / landscape: a bit more breathing room and a third column */
@media (min-width: 1024px) {
  .app { max-width: 1040px; }
  .menuList { grid-template-columns: repeat(3, 1fr); }
  .qList { grid-template-columns: repeat(3, 1fr); }
}
`;
