import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/Layout";
import { useTelegram } from "../hooks/useTelegram";
import { fetchClient, patchClient, deleteClient, sendConfig } from "../api/client";


export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { haptic } = useTelegram();
  const queryClient = useQueryClient();

  const { data: client, isLoading, error } = useQuery({
    queryKey: ["client", id],
    queryFn: () => fetchClient(id!),
    enabled: !!id,
  });

  const patchMutation = useMutation({
    mutationFn: (action: "suspend" | "resume") => patchClient(id!, { action }),
    onSuccess: () => {
      haptic.notification("success");
      void queryClient.invalidateQueries({ queryKey: ["client", id] });
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteClient(id!),
    onSuccess: () => {
      haptic.notification("success");
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
      navigate("/");
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  const configMutation = useMutation({
    mutationFn: () => sendConfig(id!),
    onSuccess: () => {
      haptic.notification("success");
      alert("Config sent to your Telegram chat!");
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  if (isLoading) {
    return <Layout backTo="/" title="Client"><div className="text-tg-hint py-8 text-center">Loading…</div></Layout>;
  }

  if (error || !client) {
    return <Layout backTo="/" title="Client"><div className="text-tg-destructive py-8 text-center">Client not found.</div></Layout>;
  }

  const typeLabel = client.type === "both" ? "WireGuard + XRay" : client.type.toUpperCase();
  const isActive = client.is_active === 1;

  const handleDelete = () => {
    if (window.confirm(`Delete ${client.name}? This cannot be undone.`)) {
      deleteMutation.mutate();
    }
  };

  return (
    <Layout backTo="/" title={client.name}>
      {/* Info card */}
      <div className="bg-tg-secondary rounded-xl p-4 mb-4">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-tg-hint">Status</div>
          <div className={isActive ? "text-green-500 font-medium" : "text-red-500 font-medium"}>
            {isActive ? "Active" : "Suspended"}
          </div>

          <div className="text-tg-hint">Type</div>
          <div className="text-tg">{typeLabel}</div>

          {client.wg_ip && (
            <>
              <div className="text-tg-hint">WG IP</div>
              <div className="text-tg font-mono text-xs">{client.wg_ip}</div>
            </>
          )}

          {client.expires_at && (
            <>
              <div className="text-tg-hint">Expires</div>
              <div className="text-tg">{new Date(client.expires_at).toLocaleDateString()}</div>
            </>
          )}

          <div className="text-tg-hint">Created</div>
          <div className="text-tg">{new Date(client.created_at).toLocaleDateString()}</div>
        </div>
      </div>

      {/* Actions */}
      <div className="space-y-2">
        {/* Send Config */}
        <button
          onClick={() => configMutation.mutate()}
          disabled={configMutation.isPending}
          className="w-full px-4 py-3 rounded-xl bg-tg-button text-tg-button font-medium text-sm disabled:opacity-60"
        >
          {configMutation.isPending ? "Sending…" : "📩 Send Config to Chat"}
        </button>

        {/* Suspend / Resume */}
        {isActive ? (
          <button
            onClick={() => patchMutation.mutate("suspend")}
            disabled={patchMutation.isPending}
            className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
          >
            {patchMutation.isPending ? "Suspending…" : "⏸ Suspend"}
          </button>
        ) : (
          <button
            onClick={() => patchMutation.mutate("resume")}
            disabled={patchMutation.isPending}
            className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
          >
            {patchMutation.isPending ? "Resuming…" : "▶ Resume"}
          </button>
        )}

        {/* Delete */}
        <button
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
          className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg-destructive font-medium text-sm border border-tg disabled:opacity-60"
        >
          {deleteMutation.isPending ? "Deleting…" : "🗑 Delete Client"}
        </button>
      </div>
    </Layout>
  );
}
