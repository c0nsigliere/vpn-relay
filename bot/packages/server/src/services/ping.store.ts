interface PingResult {
  ms: number;
  lossPercent: number;
}

let current: PingResult | null = null;

export function setPing(result: PingResult): void {
  current = result;
}

export function getPing(): PingResult | null {
  return current;
}
