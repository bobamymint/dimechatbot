import { siteConfig } from "@/lib/config";

export const metadata = {
  title: `${siteConfig.name} — Admin`,
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-ink-950/[0.02]">{children}</div>;
}
