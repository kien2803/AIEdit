import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "@aiedit/ui/styles.css";

const errBox = document.createElement("pre");
errBox.id = "fatal-err";
errBox.style.cssText =
  "position:fixed;inset:auto 0 0 0;max-height:40%;overflow:auto;background:#3a0000;color:#ffb0b0;padding:12px;font:11px monospace;z-index:9999;white-space:pre-wrap;display:none";
document.body.appendChild(errBox);
function showFatal(msg: string) {
  errBox.style.display = "block";
  errBox.textContent += msg + "\n\n";
}
window.addEventListener("error", (e) => showFatal(`${e.message}\n${e.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", (e) => showFatal(`unhandled rejection: ${e.reason?.stack ?? e.reason}`));

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
