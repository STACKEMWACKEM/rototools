import { evaluate } from "./mask";
self.onmessage = (e) => {
  const { id, project, frame, width, height, models } = e.data;
  try {
    const alpha = evaluate(project, frame, width, height, models);
    self.postMessage({ id, alpha }, { transfer: [alpha.buffer] });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
