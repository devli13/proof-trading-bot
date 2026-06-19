import { Dashboard } from "@/components/dashboard";

// Client hydrates immediately (skeleton → realtime). Kept a server component so the
// shell streams instantly; the fleet data loads client-side via the realtime hook.
export default function Page() {
  return <Dashboard initial={null} />;
}
