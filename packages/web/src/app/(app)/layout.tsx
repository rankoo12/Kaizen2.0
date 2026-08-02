import KaizenApp from '@/components/design/kaizen-app';

/* The authenticated experience is now the native macOS design (Kaizen (1)).
 * It owns its own window chrome, sidebar and screen navigation, so the old
 * SideRail/TopBar shell and the per-route pages are no longer rendered here.
 * Auth gating stays enforced by middleware. */
export default function AppShellLayout() {
  return <KaizenApp />;
}
