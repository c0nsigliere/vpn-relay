import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "../components/Layout";
import { ClientRow } from "../components/ClientRow";
import { useTelegram } from "../hooks/useTelegram";
import { fetchClients } from "../api/client";

type FilterStatus = "all" | "active" | "suspended";
type FilterType = "all" | "wg" | "xray" | "both";

export function ClientList() {
  const navigate = useNavigate();
  const { mainButton, haptic } = useTelegram();

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [page, setPage] = useState(0);

  // Debounce search
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["clients", debouncedSearch, filterStatus, filterType, page],
    queryFn: () => fetchClients({ search: debouncedSearch, filter: filterStatus, type: filterType, page }),
  });

  // MainButton → Add Client
  useEffect(() => {
    if (!mainButton) return;
    mainButton.setText("+ Add Client");
    mainButton.show();
    mainButton.enable();
    const handler = () => {
      haptic.impact("light");
      navigate("/add");
    };
    mainButton.onClick(handler);
    return () => {
      mainButton.offClick(handler);
      mainButton.hide();
    };
  }, [mainButton, navigate, haptic]);

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <Layout title="VPN Clients">
      {/* Search */}
      <div className="mb-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients…"
          className="w-full px-3 py-2 rounded-lg bg-tg-secondary text-tg placeholder-tg-hint text-sm border border-tg focus:outline-none"
        />
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {(["all", "active", "suspended"] as FilterStatus[]).map((f) => (
          <button
            key={f}
            onClick={() => { setFilterStatus(f); setPage(0); }}
            className={`px-3 py-1 rounded-full text-xs whitespace-nowrap border ${
              filterStatus === f
                ? "bg-tg-button text-tg-button border-transparent"
                : "bg-tg-secondary text-tg-hint border-tg"
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <div className="w-px bg-tg-secondary" />
        {(["all", "wg", "xray", "both"] as FilterType[]).map((t) => (
          <button
            key={t}
            onClick={() => { setFilterType(t); setPage(0); }}
            className={`px-3 py-1 rounded-full text-xs whitespace-nowrap border ${
              filterType === t
                ? "bg-tg-button text-tg-button border-transparent"
                : "bg-tg-secondary text-tg-hint border-tg"
            }`}
          >
            {t === "all" ? "All Types" : t.toUpperCase()}
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading && (
        <div className="text-center text-tg-hint py-8">Loading…</div>
      )}
      {error && (
        <div className="text-center text-tg-destructive py-8">
          {(error as Error).message}
        </div>
      )}
      {data && data.clients.length === 0 && (
        <div className="text-center text-tg-hint py-8">
          {debouncedSearch ? "No clients match your search." : "No clients yet."}
        </div>
      )}
      {data && data.clients.length > 0 && (
        <div className="bg-tg-secondary rounded-xl divide-y divide-tg px-3">
          {data.clients.map((c) => (
            <ClientRow key={c.id} client={c} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-between items-center mt-4">
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            className="px-4 py-2 rounded-lg bg-tg-secondary text-tg text-sm disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="text-tg-hint text-sm">
            {page + 1} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
            className="px-4 py-2 rounded-lg bg-tg-secondary text-tg text-sm disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}

      {/* Total */}
      {data && (
        <p className="text-center text-tg-hint text-xs mt-4">
          {data.total} client{data.total !== 1 ? "s" : ""} total
        </p>
      )}
    </Layout>
  );
}
