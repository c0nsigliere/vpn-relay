/**
 * XRay service — uses the local xray CLI for stats and atomic clients.json
 * writes + service restart for client management.
 *
 * This avoids gRPC proto dependency hell: XRay proto files have deep
 * transitive imports that are impractical to bundle. The xray binary itself
 * provides a built-in `xray api` CLI that communicates with the local gRPC
 * endpoint using its own bundled proto definitions.
 */
export interface VlessUris {
    direct: string;
    relay: string;
}
export interface ClientStats {
    uplinkBytes: bigint;
    downlinkBytes: bigint;
}
declare class XrayService {
    addClient(name: string, uuid?: string): Promise<string>;
    removeClient(name: string, uuid: string): Promise<void>;
    getStats(name: string, reset?: boolean): Promise<ClientStats>;
    queryAllStats(reset?: boolean): Promise<Map<string, ClientStats>>;
    generateVlessUris(name: string, uuid: string): VlessUris;
    private syncClientsJson;
    private syncConfigJson;
    private restartXray;
    private queryStatsCli;
    close(): void;
}
export declare const xrayService: XrayService;
export {};
//# sourceMappingURL=xray.service.d.ts.map