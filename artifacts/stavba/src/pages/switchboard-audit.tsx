import { ScrollText } from "lucide-react";
import { SwitchboardAuditTrail } from "@/components/switchboard-audit-trail";

export default function SwitchboardAudit() {
  return <div className="max-w-7xl mx-auto w-full p-4 md:p-6"><div className="mb-5"><h1 className="text-2xl font-bold flex items-center gap-2"><ScrollText className="h-6 w-6 text-cyan-600" />Audit rozvaděčů</h1><p className="text-sm text-muted-foreground mt-1">Pouze ke čtení: dokumentace, parser, checklisty, měření, závady, QR, štítky a protokoly.</p></div><div className="border-y bg-card"><SwitchboardAuditTrail /></div></div>;
}
