import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "../components/Layout";
import { ServerStatusCard } from "../components/ServerStatusCard";
import { useTelegram } from "../hooks/useTelegram";
import { fetchServersStatus } from "../api/client";

export function Dashboard() {
  const navigate = useNavigate();
  const { haptic } = useTelegram();

  const { data, isLoading } = useQuery({
    queryKey: ["servers-status"],
    queryFn: fetchServersStatus,
    refetchInterval: 30_000,
    retry: false,
  });

  return (
    <Layout title="Dashboard">
      {/* Server status */}
      <div className="space-y-2 mb-5">
        <ServerStatusCard
          title="Server A (entry)"
          serverId="a"
          status={isLoading ? undefined : data?.serverA}
          sparklineData={data?.trafficSparklineA}
          trafficTotal24h={data?.trafficTotal24hA}
          onClick={() => { haptic.impact("light"); navigate("/server/a"); }}
        />
        <ServerStatusCard
          title="Server B (exit)"
          serverId="b"
          status={isLoading ? undefined : data?.serverB}
          sparklineData={data?.trafficSparklineB}
          trafficTotal24h={data?.trafficTotal24hB}
          onClick={() => { haptic.impact("light"); navigate("/server/b"); }}
        />
      </div>

      {/* Quick-nav tiles */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => { haptic.impact("light"); navigate("/clients"); }}
          className="bg-tg-secondary rounded-xl p-4 text-left"
        >
          <div className="text-2xl mb-1">👥</div>
          <div className="font-medium text-sm text-tg">Clients</div>
          <div className="text-xs text-tg-hint">Manage VPN clients</div>
        </button>

        <button
          onClick={() => { haptic.impact("light"); navigate("/add"); }}
          className="bg-tg-secondary rounded-xl p-4 text-left"
        >
          <div className="text-2xl mb-1">➕</div>
          <div className="font-medium text-sm text-tg">Add Client</div>
          <div className="text-xs text-tg-hint">Create new client</div>
        </button>

        <button
          onClick={() => { haptic.impact("light"); navigate("/settings"); }}
          className="bg-tg-secondary rounded-xl p-4 text-left"
        >
          <div className="text-2xl mb-1">⚙️</div>
          <div className="font-medium text-sm text-tg">Settings</div>
          <div className="text-xs text-tg-hint">Backup & config</div>
        </button>
      </div>
    </Layout>
  );
}
