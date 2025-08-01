import { html } from "@/utils/html";

console.log("[MAIN]", "this is client-side script");

const { AArrowUp } = await import("lucide");
const text = html`
  <div>Hello, world</div>
  <p>${JSON.stringify(AArrowUp)}</p>
`;

console.log("[MAIN]", text);

document.addEventListener("DOMContentLoaded", () => {
  const worker = new Worker("/frontend/worker.ts?worker");
  worker.postMessage("Hi");
});
