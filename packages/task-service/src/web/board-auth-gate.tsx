import { useEffect, useState } from "react";
import { Button, Skeleton, Textarea as AppTextarea } from "./ui.js";
import {
  ApiError,
  BOARD_AUTH_REQUIRED_EVENT,
  fetchBoardPairingStatus,
  fetchBoardSession,
  startBoardPairing,
  type BoardPairingStart
} from "./api-client.js";
import { copyText } from "./copy-text.js";
import { TaskBoard } from "./task-board.js";

type AccessState =
  | { kind: "checking" }
  | { kind: "setup" }
  | { kind: "ready"; owner: string };

type CopyState = "idle" | "copying" | "copied" | "failed";

export function BoardAuthGate() {
  const [access, setAccess] = useState<AccessState>({ kind: "checking" });
  const [pairing, setPairing] = useState<BoardPairingStart | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await fetchBoardSession();
        if (cancelled) return;
        setAccess(session.authenticated
          ? { kind: "ready", owner: session.owner }
          : { kind: "setup" });
      } catch {
        if (!cancelled) setAccess({ kind: "setup" });
      }
    })();
    const requireAuthentication = () => {
      setPairing(null);
      setPairingError(null);
      setCopyState("idle");
      setAccess({ kind: "setup" });
    };
    window.addEventListener(BOARD_AUTH_REQUIRED_EVENT, requireAuthentication);
    return () => {
      cancelled = true;
      window.removeEventListener(BOARD_AUTH_REQUIRED_EVENT, requireAuthentication);
    };
  }, []);

  useEffect(() => {
    if (pairing === null || pairingError !== null) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const status = await fetchBoardPairingStatus(pairing.challenge_id);
        if (cancelled) return;
        if (status.status === "paired") {
          setAccess({ kind: "ready", owner: status.owner });
          setPairing(null);
          return;
        }
        timer = window.setTimeout(() => void poll(), 1_000);
      } catch (error) {
        if (!cancelled) {
          setPairingError(describePairingError(error));
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 700);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [pairing, pairingError]);

  if (access.kind === "ready") {
    return <TaskBoard owner={access.owner} />;
  }

  if (access.kind === "checking") {
    return (
      <main className="board-auth-page" aria-label="正在检查 Board 会话">
        <section className="board-auth-card">
          <Skeleton className="board-auth-skeleton" />
          <Skeleton className="board-auth-skeleton board-auth-skeleton-short" />
        </section>
      </main>
    );
  }

  const agentInstruction = pairing === null
    ? ""
    : `请调用 board_pair，pairing_code: ${pairing.pairing_code}`;

  return (
    <main className="board-auth-page">
      <section className="board-auth-card" aria-labelledby="board-auth-title">
        <div className="board-auth-mark" aria-hidden="true">MCP</div>
        <h1 id="board-auth-title">此设备尚未初始化 Board</h1>
        <p className="board-auth-lead">
          为避免暴露其他人的项目和验收操作，请先通过已安装并初始化的 Agent 完成身份配对。
        </p>
        <ol className="board-auth-steps">
          <li>在本机 Agent 中安装 CLI Session Task MCP。</li>
          <li>在实际项目 worktree 执行 <code>session_context</code>，绑定 Git owner。</li>
          <li>生成配对码，并让同一个 Agent 调用 <code>board_pair</code>。</li>
        </ol>

        {pairing === null ? (
          <Button
            size="lg"
            disabled={creating}
            onClick={() => {
              setCreating(true);
              setPairingError(null);
              void startBoardPairing().then((created) => {
                setPairing(created);
                setCopyState("idle");
              }).catch((error: unknown) => {
                setPairingError(describePairingError(error));
              }).finally(() => setCreating(false));
            }}
          >
            {creating ? "正在生成…" : "生成一次性配对码"}
          </Button>
        ) : (
          <div className="board-pairing" aria-live="polite">
            <span className="board-pairing-label">一次性配对码</span>
            <strong className="board-pairing-code">{pairing.pairing_code}</strong>
            <span className="board-pairing-expiry">
              有效期至 {new Date(pairing.expires_at).toLocaleTimeString()}
            </span>
            <label className="board-agent-instruction">
              <span>Agent 指令（也可手动选择复制）</span>
              <AppTextarea
                aria-label="Agent 指令"
                className="board-agent-instruction-textarea resize-none"
                readOnly
                rows={2}
                value={agentInstruction}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <div className="board-pairing-actions">
              <Button
                variant="outline"
                disabled={copyState === "copying"}
                onClick={() => {
                  setCopyState("copying");
                  void copyText(agentInstruction).then(() => {
                    setCopyState("copied");
                  }).catch(() => setCopyState("failed"));
                }}
              >
                {copyState === "copying"
                  ? "正在复制…"
                  : copyState === "copied"
                    ? "已复制 Agent 指令"
                    : "复制 Agent 指令"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPairing(null);
                  setPairingError(null);
                  setCopyState("idle");
                }}
              >
                重新生成
              </Button>
            </div>
            {copyState === "failed" && (
              <p role="alert" className="board-copy-error">
                自动复制失败，请手动选择上方的完整 Agent 指令复制。
              </p>
            )}
            <p className="board-pairing-waiting">等待 Agent 确认，配对成功后将自动进入看板…</p>
          </div>
        )}

        {pairingError !== null && (
          <p role="alert" className="board-auth-error">{pairingError}</p>
        )}
      </section>
    </main>
  );
}

function describePairingError(error: unknown): string {
  if (error instanceof ApiError) {
    return `配对失败（${error.code}）：${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
