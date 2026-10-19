import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@leke/components";
import { BoardAuthGate } from "./board-auth-gate.js";
import "@leke/components/styles.css";
import "./styles.css";

// LeComponents switches themes via a `.dark` class on <html>, while our own
// tokens use the color-scheme media query. Sync the class with the system
// preference so both layers flip together.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function syncDarkClass(): void {
  document.documentElement.classList.toggle("dark", darkQuery.matches);
}
darkQuery.addEventListener("change", syncDarkClass);
syncDarkClass();

const container = document.querySelector("#root");
if (container === null) {
  throw new Error("Board root element #root is missing");
}

createRoot(container).render(
  <StrictMode>
    <BoardAuthGate />
    <Toaster position="top-center" theme="system" />
  </StrictMode>
);
