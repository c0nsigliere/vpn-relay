import type { Client, TrafficSnapshot } from "@vpn-relay/shared";
export type { Client, TrafficSnapshot };
export declare const queries: {
    getAllClients(): Client[];
    getClientById(id: string): Client | undefined;
    getClientByName(name: string): Client | undefined;
    insertClient(client: Omit<Client, "created_at">): void;
    deleteClient(id: string): void;
    setClientActive(id: string, active: boolean): void;
    insertTrafficSnapshot(snapshot: Omit<TrafficSnapshot, "id" | "ts">): void;
    getTrafficHistory(clientId: string, limit?: number): TrafficSnapshot[];
    getExpiredClients(): Client[];
    getActiveClients(): Client[];
    getLastTrafficSnapshot(clientId: string): TrafficSnapshot | undefined;
    getPagedClients(page: number, pageSize?: number): {
        clients: Client[];
        total: number;
    };
    searchClients(search: string, filter: "all" | "active" | "suspended", type: "all" | "wg" | "xray" | "both", page: number, pageSize?: number): {
        clients: Client[];
        total: number;
    };
};
//# sourceMappingURL=queries.d.ts.map