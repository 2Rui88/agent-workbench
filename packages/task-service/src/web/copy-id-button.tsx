import { useState } from "react";
import { Button } from "@leke/components";
import { copyText } from "./copy-text.js";

type CopyState = "idle" | "copying" | "copied" | "failed";

export interface CopyIdButtonProps {
  id: string;
  label: string;
}

export function CopyIdButton({ id, label }: CopyIdButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const ariaLabel = state === "copied"
    ? `${label}已复制`
    : state === "failed"
      ? `${label}复制失败，点击重试`
      : `复制${label}`;

  function handleCopy(): void {
    if (state === "copying") {
      return;
    }
    setState("copying");
    void copyText(id)
      .then(() => setState("copied"))
      .catch(() => setState("failed"));
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="copy-id-button"
      data-copy-id={id}
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={state === "copying"}
      onClick={handleCopy}
    >
      <svg
        className="copy-id-icon"
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {state === "copied" ? (
          <path d="m3 8.5 3 3 7-7" />
        ) : state === "failed" ? (
          <>
            <circle cx="8" cy="8" r="6" />
            <path d="M8 4.5v4M8 11.5h.01" />
          </>
        ) : (
          <>
            <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
            <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
          </>
        )}
      </svg>
    </Button>
  );
}
