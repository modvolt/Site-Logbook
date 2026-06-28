import { useParams, Link } from "wouter";
import {
  useGetPerson,
  useListPpeAssignments,
  getGetPersonQueryKey,
  getListPpeAssignmentsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, User, Shield, AlertCircle, Clock, CheckCircle2, Plus } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import {
  PPE_STATUS_LABELS,
  PPE_STATUS_COLORS,
  isPpeOverdue,
  formatPpeDate,
} from "@/lib/ppe-format";
import { PpeEventHistory } from "@/components/ppe-event-history";

function PpeStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PPE_STATUS_COLORS[status] ?? ""}`}>
      {PPE_STATUS_LABELS[status] ?? status}
    </span>
  );
}

export default function PersonDetail() {
  const { id } = useParams<{ id: string }>();
  const personId = parseInt(id ?? "0");
  const { can } = useAuth();

  const { data: person, isLoading: personLoading } = useGetPerson(personId, {
    query: { queryKey: getGetPersonQueryKey(personId), enabled: !!personId },
  });

  const { data: assignments, isLoading: assignmentsLoading } = useListPpeAssignments(
    { personId },
    { query: { queryKey: getListPpeAssignmentsQueryKey({ personId }), enabled: !!personId } },
  );

  const issuedAssignments = (assignments ?? []).filter((a) => a.status === "issued");
  const overdueCount = issuedAssignments.filter((a) => isPpeOverdue(a)).length;
  const unconfirmedCount = issuedAssignments.filter((a) => !a.handoverDocument).length;

  if (personLoading) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto w-full">
        <Skeleton className="h-6 w-32 mb-4" />
        <Skeleton className="h-12 w-48 mb-6" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!person) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto w-full">
        <Link href="/people" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="h-4 w-4" /> Zpět na zaměstnance
        </Link>
        <div className="text-center py-16 text-muted-foreground">
          <User className="h-12 w-12 mx-auto mb-4 opacity-20" />
          <p>Zaměstnanec nenalezen.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto w-full">
      <Link href="/people" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="h-4 w-4" /> Zpět na zaměstnance
      </Link>

      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 p-3 rounded-full text-primary">
            <User className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{person.name}</h1>
            {person.createdAt && (
              <p className="text-sm text-muted-foreground">
                Zaměstnanec od {new Date(person.createdAt).toLocaleDateString("cs-CZ")}
              </p>
            )}
          </div>
        </div>
        {can("write") && (
          <Button asChild className="h-10">
            <Link href={`/stroje/oopp?personId=${person.id}`}>
              <Plus className="h-5 w-5 mr-2" />
              Vydat OOPP
            </Link>
          </Button>
        )}
      </div>

      {/* OOPP Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-lg flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" /> OOPP – Ochranné pracovní prostředky
            </CardTitle>
            <Link
              href={`/stroje/oopp?personId=${person.id}`}
              className="text-sm text-muted-foreground hover:text-primary transition-colors"
            >
              Zobrazit vše →
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {/* Summary strip */}
          {issuedAssignments.length > 0 && (
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="rounded-lg border bg-muted/30 p-2.5 text-center">
                <CheckCircle2 className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
                <div className="text-xl font-bold">{issuedAssignments.length}</div>
                <div className="text-[11px] text-muted-foreground">Vydáno</div>
              </div>
              <div className={`rounded-lg border p-2.5 text-center ${overdueCount > 0 ? "border-destructive/30 bg-destructive/10" : "bg-muted/30"}`}>
                <AlertCircle className={`h-4 w-4 mx-auto mb-1 ${overdueCount > 0 ? "text-destructive" : "text-muted-foreground"}`} />
                <div className="text-xl font-bold">{overdueCount}</div>
                <div className="text-[11px] text-muted-foreground">Po termínu</div>
              </div>
              <div className={`rounded-lg border p-2.5 text-center ${unconfirmedCount > 0 ? "border-amber-400/50 bg-amber-50 dark:bg-amber-950/20" : "bg-muted/30"}`}>
                <Clock className={`h-4 w-4 mx-auto mb-1 ${unconfirmedCount > 0 ? "text-amber-600" : "text-muted-foreground"}`} />
                <div className="text-xl font-bold">{unconfirmedCount}</div>
                <div className="text-[11px] text-muted-foreground">Bez potv.</div>
              </div>
            </div>
          )}

          {assignmentsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : issuedAssignments.length > 0 ? (
            <div className="space-y-2">
              {issuedAssignments.map((a) => (
                <div
                  key={a.id}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${isPpeOverdue(a) ? "border-destructive/30 bg-destructive/5" : "border-border"}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <span className="font-medium text-sm">{a.ppeNameSnapshot}</span>
                      <PpeStatusBadge status={a.status} />
                      {isPpeOverdue(a) && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 text-destructive px-1.5 py-0.5 text-[11px] font-medium">
                          <AlertCircle className="h-3 w-3" /> Po termínu
                        </span>
                      )}
                      {a.handoverDocument ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 font-medium">
                          <CheckCircle2 className="h-3 w-3" /> {a.handoverDocument.documentNumber}
                        </span>
                      ) : (
                        <span className="inline-flex px-1.5 py-0.5 rounded-full text-[11px] bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-medium">
                          Bez protokolu
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>Vydáno: {formatPpeDate(a.issuedAt)}</span>
                      {a.replaceBy && <span>Výměna: {formatPpeDate(a.replaceBy)}</span>}
                      {a.nextInspectionAt && <span>Kontrola: {formatPpeDate(a.nextInspectionAt)}</span>}
                      {a.size && <span>Vel.: {a.size}</span>}
                    </div>
                    <PpeEventHistory assignmentId={a.id} />
                  </div>
                </div>
              ))}
              {can("write") && (
                <div className="pt-2">
                  <Button variant="outline" size="sm" asChild className="w-full">
                    <Link href={`/stroje/oopp?personId=${person.id}`}>
                      <Plus className="h-4 w-4 mr-2" /> Vydat další OOPP
                    </Link>
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Shield className="h-10 w-10 mx-auto mb-3 opacity-20" />
              <p className="text-sm">Žádné vydané OOPP.</p>
              {can("write") && (
                <Button variant="link" size="sm" asChild className="mt-2">
                  <Link href={`/stroje/oopp?personId=${person.id}`}>
                    Vydat OOPP
                  </Link>
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
