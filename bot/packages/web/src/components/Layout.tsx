import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTelegram } from "../hooks/useTelegram";

interface LayoutProps {
  children: React.ReactNode;
  backTo?: string;
  title?: string;
}

export function Layout({ children, backTo, title }: LayoutProps) {
  const navigate = useNavigate();
  const { backButton } = useTelegram();

  useEffect(() => {
    if (!backButton) return;
    if (backTo) {
      backButton.show();
      const handler = () => navigate(backTo);
      backButton.onClick(handler);
      return () => {
        backButton.offClick(handler);
        backButton.hide();
      };
    } else {
      backButton.hide();
    }
  }, [backTo, navigate, backButton]);

  return (
    <div className="min-h-screen bg-tg">
      {title && (
        <div className="px-4 pt-4 pb-2">
          <h1 className="text-lg font-semibold text-tg">{title}</h1>
        </div>
      )}
      <div className="px-4 pb-24">{children}</div>
    </div>
  );
}
