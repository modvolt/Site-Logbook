import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, Save, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  getListUsersQueryKey,
  useUpdateUserPermissions,
  type AuthUser,
  type UserPermissionOverride,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { Permission } from "@/hooks/use-auth";

type Choice = "inherit" | "allow" | "deny";

const GROUPS: Array<{ label: string; entries: Array<{ permission: Permission; label: string }> }> = [
  { label: "Zakázky", entries: [
    { permission: "jobs.view", label: "Zobrazit" },
    { permission: "jobs.work", label: "Pracovat na přiřazených zakázkách" },
    { permission: "jobs.manage", label: "Vytvářet a spravovat všechny zakázky" },
  ] },
  { label: "Dlouhodobé akce", entries: [{ permission: "activities.view", label: "Zobrazit" }, { permission: "activities.manage", label: "Vytvářet a upravovat" }] },
  { label: "Zákazníci", entries: [{ permission: "customers.view", label: "Zobrazit" }, { permission: "customers.manage", label: "Vytvářet a upravovat" }] },
  { label: "Zaměstnanci", entries: [{ permission: "people.view", label: "Zobrazit" }, { permission: "people.manage", label: "Vytvářet a upravovat" }] },
  { label: "Sklad", entries: [{ permission: "warehouse.view", label: "Zobrazit" }, { permission: "warehouse.manage", label: "Měnit skladové pohyby" }] },
  { label: "Stroje", entries: [{ permission: "machines.view", label: "Zobrazit" }, { permission: "machines.manage", label: "Vytvářet a upravovat" }] },
  { label: "Rozvaděče – evidence", entries: [
    { permission: "switchboards.view", label: "Zobrazit rozvaděče" },
    { permission: "switchboards.create", label: "Vytvářet rozvaděče" },
    { permission: "switchboards.update", label: "Upravovat rozvaděče" },
    { permission: "switchboards.archive", label: "Archivovat rozvaděče" },
    { permission: "switchboards.documents.view", label: "Zobrazit interní dokumentaci" },
    { permission: "switchboards.documents.upload", label: "Nahrávat dokumentaci" },
    { permission: "switchboards.documents.publish", label: "Zveřejnit dokument zákazníkovi" },
  ] },
  { label: "Rozvaděče – výroba", entries: [
    { permission: "switchboards.checklist.fill", label: "Vyplňovat checklist" },
    { permission: "switchboards.checklist.edit_own", label: "Upravit vlastní záznam" },
    { permission: "switchboards.checklist.edit_all", label: "Upravit cizí záznam" },
    { permission: "switchboards.measurements.create", label: "Zadávat měření" },
    { permission: "switchboards.photos.create", label: "Přidávat fotografie" },
    { permission: "switchboards.defects.create", label: "Vytvářet závady" },
    { permission: "switchboards.defects.close", label: "Uzavírat závady" },
    { permission: "switchboards.phases.complete", label: "Dokončit pracovní fázi" },
    { permission: "switchboards.protocol.complete", label: "Dokončit protokol" },
  ] },
  { label: "Rozvaděče – kontrola a správa", entries: [
    { permission: "switchboards.extraction.review", label: "Kontrolovat vytěžené údaje" },
    { permission: "switchboards.extraction.correct", label: "Opravovat vytěžené údaje" },
    { permission: "switchboards.labels.generate", label: "Generovat typový štítek" },
    { permission: "switchboards.labels.approve", label: "Schválit typový štítek" },
    { permission: "switchboards.protocol.override", label: "Administrátorský override" },
    { permission: "switchboards.templates.manage", label: "Spravovat checklistové šablony" },
    { permission: "switchboards.parser.manage", label: "Spravovat parser a aliasy" },
    { permission: "switchboards.qr.manage", label: "Spravovat QR přístup" },
    { permission: "switchboards.audit.view", label: "Zobrazit auditní stopu" },
  ] },
  { label: "Evidence času", entries: [{ permission: "time.manage", label: "Spravovat časové záznamy" }] },
  { label: "Hodinové sazby", entries: [
    { permission: "rates.cost.view", label: "Zobrazit nákladovou sazbu" },
    { permission: "rates.sale.view", label: "Zobrazit prodejní sazbu" },
    { permission: "rates.manage", label: "Měnit sazby" },
  ] },
  { label: "Přístupové údaje", entries: [{ permission: "credentials.view", label: "Zobrazit" }, { permission: "credentials.manage", label: "Měnit" }] },
  { label: "Fakturace", entries: [
    { permission: "billing.view", label: "Zobrazit finanční údaje" },
    { permission: "billing.manage", label: "Upravovat doklady a faktury" },
    { permission: "billing.approve", label: "Schvalovat doklady" },
    { permission: "billing.settings", label: "Spravovat nastavení a import" },
  ] },
  { label: "Statistika", entries: [{ permission: "statistics.view", label: "Zobrazit" }] },
  { label: "Nabídky", entries: [{ permission: "quotes.view", label: "Zobrazit" }, { permission: "quotes.manage", label: "Vytvářet a upravovat" }] },
  { label: "Nastavení", entries: [{ permission: "settings.view", label: "Zobrazit" }, { permission: "settings.manage", label: "Měnit" }] },
  { label: "Diagnostika", entries: [{ permission: "diagnostics.view", label: "Zobrazit" }, { permission: "diagnostics.manage", label: "Provádět servisní akce" }] },
  { label: "Audit", entries: [{ permission: "audit.view", label: "Zobrazit historii změn" }] },
  { label: "Uživatelé", entries: [{ permission: "users.manage", label: "Spravovat uživatele a oprávnění" }] },
];

function draftFrom(overrides: UserPermissionOverride[]): Record<string, Choice> {
  return Object.fromEntries(overrides.map((item) => [item.permission, item.effect]));
}

export function UserPermissionEditor({ user, currentUserId, onClose }: {
  user: AuthUser;
  currentUserId?: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateUserPermissions();
  const [draft, setDraft] = useState<Record<string, Choice>>(() => draftFrom(user.permissionOverrides));

  useEffect(() => setDraft(draftFrom(user.permissionOverrides)), [user]);

  const changed = useMemo(() => {
    const original = draftFrom(user.permissionOverrides);
    const keys = new Set([...Object.keys(original), ...Object.keys(draft)]);
    return [...keys].some((key) => (original[key] ?? "inherit") !== (draft[key] ?? "inherit"));
  }, [draft, user.permissionOverrides]);

  const save = () => {
    const overrides = Object.entries(draft)
      .filter((entry): entry is [string, "allow" | "deny"] => entry[1] === "allow" || entry[1] === "deny")
      .map(([permission, effect]) => ({ permission, effect }));
    update.mutate({ id: user.id, data: { overrides } }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        if (user.id === currentUserId) void queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        toast({ title: "Oprávnění uložena" });
        onClose();
      },
      onError: (error: any) => toast({
        title: "Oprávnění se nepodařilo uložit",
        description: error?.message,
        variant: "destructive",
      }),
    });
  };

  return (
    <section className="mt-4 border bg-card" aria-label={`Oprávnění uživatele ${user.name}`}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-semibold flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-rose-600" /> Oprávnění: {user.name}</h2>
          <p className="text-xs text-muted-foreground mt-1">Dle role zachová výchozí chování role {user.role}. Povolit nebo zakázat má přednost.</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} title="Zavřít oprávnění"><X className="h-4 w-4" /></Button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2">
        {GROUPS.map((group) => (
          <div key={group.label} className="border-b lg:odd:border-r p-4">
            <h3 className="text-sm font-semibold mb-2">{group.label}</h3>
            <div className="space-y-2">
              {group.entries.map((entry) => {
                const value = draft[entry.permission] ?? "inherit";
                const effective = value === "allow" || (value === "inherit" && user.permissions.includes(entry.permission));
                const selfLock = user.id === currentUserId && entry.permission === "users.manage";
                return (
                  <div key={entry.permission} className="grid grid-cols-[1fr_9rem] items-center gap-3">
                    <div className="min-w-0">
                      <p className="text-sm">{entry.label}</p>
                      <p className={`text-xs ${effective ? "text-emerald-600" : "text-muted-foreground"}`}>{effective ? "Aktivní" : "Bez přístupu"}</p>
                    </div>
                    <Select value={value} onValueChange={(next: Choice) => setDraft((current) => ({ ...current, [entry.permission]: next }))}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit" disabled={selfLock && user.role !== "admin"}>Dle role</SelectItem>
                        <SelectItem value="allow">Povolit</SelectItem>
                        <SelectItem value="deny" disabled={selfLock}>Zakázat</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2 px-4 py-3">
        <Button variant="outline" onClick={onClose}>Zrušit</Button>
        <Button onClick={save} disabled={!changed || update.isPending}><Save className="h-4 w-4 mr-1" /> Uložit oprávnění</Button>
      </div>
    </section>
  );
}
