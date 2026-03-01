export type ClientType = "wg" | "xray" | "both";
export interface Client {
    id: string;
    name: string;
    type: ClientType;
    wg_ip: string | null;
    wg_pubkey: string | null;
    xray_uuid: string | null;
    created_at: string;
    expires_at: string | null;
    is_active: number;
}
export interface TrafficSnapshot {
    id: number;
    client_id: string;
    ts: string;
    wg_rx: number;
    wg_tx: number;
    xray_rx: number;
    xray_tx: number;
}
export interface CreateClientRequest {
    name: string;
    type: ClientType;
    ttlDays?: number;
}
export interface PatchClientRequest {
    action: "suspend" | "resume";
}
export interface ClientsResponse {
    clients: Client[];
    total: number;
    page: number;
    pageSize: number;
}
export interface ApiError {
    error: string;
}
//# sourceMappingURL=types.d.ts.map