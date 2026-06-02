import { pdfjs } from "react-pdf";

let configured = false;

/** iPad Safari에서 CDN·워커 불안정을 줄이기 위해 로컬 public 우선 */
export function ensurePdfJsWorker(): void {
  if (configured || typeof window === "undefined") return;
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  configured = true;
}
