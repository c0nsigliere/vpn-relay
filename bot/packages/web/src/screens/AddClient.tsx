import { useState, useEffect, useRef } from "react";
import type React from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/Layout";
import { useTelegram } from "../hooks/useTelegram";
import { createClient, fetchServersStatus } from "../api/client";
import type { ClientType } from "@vpn-relay/shared";

const NAME_RE = /^[a-zA-Z0-9_]{1,32}$/;

const inputStyle: React.CSSProperties = {
  color: "var(--tg-text)",
  WebkitTextFillColor: "var(--tg-text)",
};

const ALL_CLIENT_TYPES: { value: ClientType; label: string; desc: string }[] = [
  { value: "xray", label: "XRay (VLESS)", desc: "VLESS+Reality — best for censored regions" },
  { value: "wg", label: "WireGuard", desc: "Fast UDP tunnel — works everywhere" },
  { value: "both", label: "Both", desc: "WireGuard + XRay in one" },
];

export function AddClient() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { mainButton, haptic } = useTelegram();

  const { data: statusData } = useQuery({
    queryKey: ["servers-status"],
    queryFn: fetchServersStatus,
    staleTime: 60_000,
  });
  const isStandalone = statusData?.standalone === true;
  const CLIENT_TYPES = isStandalone
    ? ALL_CLIENT_TYPES.filter((ct) => ct.value === "xray")
    : ALL_CLIENT_TYPES;

  const [name, setName] = useState("");
  const [type, setType] = useState<ClientType>("xray");
  const [ttlDays, setTtlDays] = useState<string>("");
  const [dailyQuotaGb, setDailyQuotaGb] = useState<string>("");
  const [monthlyQuotaGb, setMonthlyQuotaGb] = useState<string>("");
  const [nameError, setNameError] = useState("");
  const [toast, setToast] = useState("");

  const nameValid = NAME_RE.test(name);
  const submittedRef = useRef(false);

  const mutation = useMutation({
    mutationFn: () =>
      createClient({
        name,
        type,
        ttlDays: ttlDays ? parseInt(ttlDays, 10) : undefined,
        dailyQuotaGb: dailyQuotaGb ? parseFloat(dailyQuotaGb) : undefined,
        monthlyQuotaGb: monthlyQuotaGb ? parseFloat(monthlyQuotaGb) : undefined,
      }),
    onSuccess: (data) => {
      haptic.notification("success");
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
      navigate(`/client/${data.client.id}`, { state: { justCreated: true } });
    },
    onError: (err: Error) => {
      submittedRef.current = false;
      haptic.notification("error");
      mainButton?.hideProgress?.();
      mainButton?.enable?.();
      setToast(err.message);
      setTimeout(() => setToast(""), 4000);
    },
  });

  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;

  // MainButton — "Create Client"
  useEffect(() => {
    if (!mainButton) return;
    if (nameValid) {
      mainButton.setText("Create Client");
      mainButton.show();
      mainButton.enable();
    } else {
      mainButton.setText("Create Client");
      mainButton.show();
      mainButton.disable();
    }

    const handler = () => {
      if (!nameValid || submittedRef.current) return;
      submittedRef.current = true;
      mainButton.showProgress?.();
      mainButton.disable?.();
      mutationRef.current.mutate();
    };

    mainButton.onClick(handler);
    return () => {
      mainButton.offClick(handler);
      mainButton.hide();
    };
  }, [mainButton, nameValid]);

  const handleNameChange = (v: string) => {
    setName(v);
    if (v && !NAME_RE.test(v)) {
      setNameError("Only letters, digits, underscores — max 32 chars");
    } else {
      setNameError("");
    }
  };

  return (
    <Layout backTo="/" title="Add Client">
      {/* Toast */}
      {toast && (
        <div className="mb-3 px-4 py-2 rounded-lg bg-red-50 text-tg-destructive text-sm">
          {toast}
        </div>
      )}

      {/* Name */}
      <div className="mb-5">
        <label className="block text-sm font-medium text-tg mb-1">
          Client Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="e.g. alice_phone"
          maxLength={32}
          style={inputStyle}
          className="w-full px-3 py-2 rounded-lg bg-tg-secondary text-tg placeholder-tg-hint text-sm border border-tg focus:outline-none"
        />
        {nameError && (
          <p className="mt-1 text-xs text-tg-destructive">{nameError}</p>
        )}
        <p className="mt-1 text-xs text-tg-hint">
          Letters, digits, underscores — max 32 characters
        </p>
      </div>

      {/* Type */}
      <div className="mb-5">
        <label className="block text-sm font-medium text-tg mb-2">
          Protocol
        </label>
        <div className="space-y-2">
          {CLIENT_TYPES.map((ct) => (
            <button
              key={ct.value}
              onClick={() => setType(ct.value)}
              className="w-full text-left px-4 py-3 rounded-xl border-2 transition-colors bg-tg-secondary"
              style={{
                borderColor: type === ct.value ? "var(--tg-button)" : "var(--tg-section-separator)",
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${
                    type === ct.value
                      ? "border-tg-button bg-tg-button"
                      : "border-tg-hint"
                  }`}
                />
                <div>
                  <div className="text-sm font-medium text-tg">{ct.label}</div>
                  <div className="text-xs text-tg-hint">{ct.desc}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* TTL (optional) */}
      <div className="mb-5">
        <label className="block text-sm font-medium text-tg mb-1">
          Expires in (days) — optional
        </label>
        <input
          type="number"
          value={ttlDays}
          onChange={(e) => setTtlDays(e.target.value)}
          placeholder="No expiry"
          min="1"
          max="3650"
          style={inputStyle}
          className="w-full px-3 py-2 rounded-lg bg-tg-secondary text-tg placeholder-tg-hint text-sm border border-tg focus:outline-none"
        />
      </div>

      {/* Quotas (optional) */}
      <div className="mb-5">
        <label className="block text-sm font-medium text-tg mb-1">
          Daily Quota (GB) — optional
        </label>
        <input
          type="number"
          value={dailyQuotaGb}
          onChange={(e) => setDailyQuotaGb(e.target.value)}
          placeholder="No daily limit"
          min="0.001"
          step="0.1"
          style={inputStyle}
          className="w-full px-3 py-2 rounded-lg bg-tg-secondary text-tg placeholder-tg-hint text-sm border border-tg focus:outline-none"
        />
      </div>

      <div className="mb-5">
        <label className="block text-sm font-medium text-tg mb-1">
          Monthly Quota (GB) — optional
        </label>
        <input
          type="number"
          value={monthlyQuotaGb}
          onChange={(e) => setMonthlyQuotaGb(e.target.value)}
          placeholder="No monthly limit"
          min="0.001"
          step="1"
          style={inputStyle}
          className="w-full px-3 py-2 rounded-lg bg-tg-secondary text-tg placeholder-tg-hint text-sm border border-tg focus:outline-none"
        />
      </div>

      {mutation.isPending && (
        <div className="text-center text-tg-hint text-sm py-2">
          Creating client and sending config to chat…
        </div>
      )}
    </Layout>
  );
}
