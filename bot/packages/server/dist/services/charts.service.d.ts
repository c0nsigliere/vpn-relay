import { TrafficSnapshot } from "../db/queries";
declare class ChartsService {
    renderTrafficChart(clientName: string, snapshots: TrafficSnapshot[]): Promise<Buffer>;
}
export declare const chartsService: ChartsService;
export {};
//# sourceMappingURL=charts.service.d.ts.map