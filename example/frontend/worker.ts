import { PanelBottom } from "lucide";

console.log("[WORKER]", PanelBottom);

self.onmessage = (event) => {
  console.log("[WORKER]", event.data);
};
