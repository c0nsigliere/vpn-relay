export interface WgClientConfig {
    privateKey: string;
    publicKey: string;
    ip: string;
    conf: string;
}
export interface WgPeerStats {
    pubkey: string;
    endpoint: string;
    allowedIps: string;
    latestHandshake: number;
    rxBytes: number;
    txBytes: number;
}
declare class WgService {
    addClient(name: string): Promise<WgClientConfig>;
    private doAddClient;
    removeClient(name: string, pubkey: string): Promise<void>;
    suspendClient(pubkey: string): Promise<void>;
    resumeClient(pubkey: string, ip: string): Promise<void>;
    getStats(): Promise<WgPeerStats[]>;
    private findFreeIp;
}
export declare const wgService: WgService;
export {};
//# sourceMappingURL=wg.service.d.ts.map