interface TextClipboard {
  writeText(text: string): Promise<void>;
}

export interface CopyTextOptions {
  clipboard?: TextClipboard | null;
  legacyCopy?: (text: string) => boolean;
}

export type CopyTextMethod = "clipboard" | "legacy";

export async function copyText(
  text: string,
  options: CopyTextOptions = {}
): Promise<CopyTextMethod> {
  const clipboard = options.clipboard === undefined
    ? browserClipboard()
    : options.clipboard;
  if (clipboard !== null) {
    try {
      await clipboard.writeText(text);
      return "clipboard";
    } catch {
      // Permission denial and insecure contexts fall through to the legacy path.
    }
  }

  const legacyCopy = options.legacyCopy ?? copyWithTextarea;
  try {
    if (legacyCopy(text)) {
      return "legacy";
    }
  } catch {
    // Surface one stable error after both browser strategies fail.
  }
  throw new Error("Browser did not allow copying text");
}

function browserClipboard(): TextClipboard | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  return navigator.clipboard ?? null;
}

function copyWithTextarea(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}
