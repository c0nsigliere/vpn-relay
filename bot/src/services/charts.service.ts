import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { TrafficSnapshot } from "../db/queries";

const WIDTH = 800;
const HEIGHT = 400;

const canvas = new ChartJSNodeCanvas({
  width: WIDTH,
  height: HEIGHT,
  backgroundColour: "#1e1e2e",
});

function formatLabel(ts: string): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function toMb(bytes: number): number {
  return parseFloat((bytes / (1024 * 1024)).toFixed(2));
}

class ChartsService {
  async renderTrafficChart(
    clientName: string,
    snapshots: TrafficSnapshot[]
  ): Promise<Buffer> {
    const labels = snapshots.map((s) => formatLabel(s.ts));
    const wgRx = snapshots.map((s) => toMb(s.wg_rx));
    const wgTx = snapshots.map((s) => toMb(s.wg_tx));
    const xrayRx = snapshots.map((s) => toMb(s.xray_rx));
    const xrayTx = snapshots.map((s) => toMb(s.xray_tx));

    const hasWg = wgRx.some((v) => v > 0) || wgTx.some((v) => v > 0);
    const hasXray = xrayRx.some((v) => v > 0) || xrayTx.some((v) => v > 0);

    const datasets = [
      ...(hasWg
        ? [
            { label: "WG ↓", data: wgRx, borderColor: "#89b4fa", backgroundColor: "transparent" },
            { label: "WG ↑", data: wgTx, borderColor: "#74c7ec", backgroundColor: "transparent" },
          ]
        : []),
      ...(hasXray
        ? [
            { label: "XRay ↓", data: xrayRx, borderColor: "#a6e3a1", backgroundColor: "transparent" },
            { label: "XRay ↑", data: xrayTx, borderColor: "#94e2d5", backgroundColor: "transparent" },
          ]
        : []),
    ];

    const config = {
      type: "line" as const,
      data: { labels, datasets },
      options: {
        responsive: false,
        plugins: {
          legend: { labels: { color: "#cdd6f4" } },
          title: {
            display: true,
            text: `Traffic — ${clientName} (MB)`,
            color: "#cdd6f4",
            font: { size: 16 },
          },
        },
        scales: {
          x: {
            ticks: { color: "#9399b2", maxTicksLimit: 12 },
            grid: { color: "#313244" },
          },
          y: {
            ticks: { color: "#9399b2" },
            grid: { color: "#313244" },
            title: { display: true, text: "MB", color: "#9399b2" },
          },
        },
      },
    };

    return canvas.renderToBuffer(config as any);
  }
}

export const chartsService = new ChartsService();
