export interface ServerStatus {
    cpuPercent: number;
    ramUsedMb: number;
    ramTotalMb: number;
    uptime: string;
    updatesAvailable: number;
    rebootRequired: boolean;
}
declare class SystemService {
    getStatusA(): Promise<ServerStatus>;
    getStatusB(): Promise<ServerStatus>;
}
export declare const systemService: SystemService;
export {};
//# sourceMappingURL=system.service.d.ts.map