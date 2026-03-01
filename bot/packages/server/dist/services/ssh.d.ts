declare class SshPool {
    private client;
    private connecting;
    private closed;
    private pendingQueue;
    private get connectConfig();
    private connect;
    exec(command: string): Promise<string>;
    ping(): Promise<boolean>;
    close(): void;
}
export declare const sshPool: SshPool;
export {};
//# sourceMappingURL=ssh.d.ts.map