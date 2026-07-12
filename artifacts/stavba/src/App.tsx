import { useEffect, Component, type ReactNode, type ErrorInfo } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { loadCompanySettings, applyTextColor, applyUiScale } from "@/lib/company-settings";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { AuthProvider, useAuth, type Permission } from "@/hooks/use-auth";
import { QuickAddDateProvider } from "@/hooks/use-quick-add-date";
import { useLiveUpdates } from "@/hooks/use-live-updates";
import { OfflineQueueProvider } from "@/hooks/use-offline-queue";
import { OfflineBanner } from "@/components/offline-banner";
import OoppSign from "@/pages/oopp-sign";
import JobSign from "@/pages/job-sign";
import QuoteShare from "@/pages/quote-share";

import Dashboard from "@/pages/dashboard";
import Calendar from "@/pages/calendar";
import Jobs from "@/pages/jobs";
import JobDetail from "@/pages/job-detail";
import JobExport from "@/pages/job-export";
import JobForm from "@/pages/job-form";
import JobGroups from "@/pages/job-groups";
import JobGroupDetail from "@/pages/job-group-detail";
import JobGroupExport from "@/pages/job-group-export";
import People from "@/pages/people";
import Customers from "@/pages/customers";
import CustomerDetail from "@/pages/customer-detail";
import SiteDetail from "@/pages/site-detail";
import PristupoveUdaje from "@/pages/pristupove-udaje";
import PristupoveUdajeExport from "@/pages/pristupove-udaje-export";
import Settings from "@/pages/settings";
import Admin from "@/pages/admin";
import Login from "@/pages/login";
import UsersAdmin from "@/pages/users-admin";
import Activities from "@/pages/activities";
import ActivityDetail from "@/pages/activity-detail";
import ActivityExport from "@/pages/activity-export";
import MyOverview from "@/pages/my-overview";
import Sklad from "@/pages/sklad";
import SkladPohyby from "@/pages/sklad-pohyby";
import Stroje from "@/pages/stroje";
import StrojDetail from "@/pages/stroj-detail";
import Oopp from "@/pages/oopp";
import OoppMoje from "@/pages/oopp-moje";
import PpeConfirm from "@/pages/ppe-confirm";
import PersonDetail from "@/pages/person-detail";
import AuditLog from "@/pages/audit-log";
import ClientErrors from "@/pages/client-errors";
import Gdpr from "@/pages/gdpr";
import Statistika from "@/pages/statistika";
import Billing from "@/pages/billing";
import BillingUnbilled from "@/pages/billing-unbilled";
import BillingUnbilledDetail from "@/pages/billing-unbilled-detail";
import BillingInvoices from "@/pages/billing-invoices";
import BillingInvoiceDetail from "@/pages/billing-invoice-detail";
import BillingInvoiceEdit from "@/pages/billing-invoice-edit";
import BillingSettings from "@/pages/billing-settings";
import BillingBankImport from "@/pages/billing-bank-import";
import BillingDocuments from "@/pages/billing-documents";
import BillingDocumentDetail from "@/pages/billing-document-detail";
import BillingReviewQueue from "@/pages/billing-review-queue";
import BillingEmailImport from "@/pages/billing-email-import";
import BillingRecurringTemplates from "@/pages/billing-recurring-templates";
import BillingRecurringTemplateDetail from "@/pages/billing-recurring-template-detail";
import AdminHealth from "@/pages/admin-health";
import AdminSessions from "@/pages/admin-sessions";
import AdminWarehouseBackfill from "@/pages/admin-warehouse-backfill";
import Quotes from "@/pages/quotes";
import QuoteDetail from "@/pages/quote-detail";
import PwaUpdatePrompt from "@/components/pwa-update-prompt";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class PageErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[PageErrorBoundary]", error, info.componentStack);
    try {
      fetch("/api/client-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: error.message.slice(0, 2000),
          stack: error.stack?.slice(0, 10000) ?? null,
          componentStack: info.componentStack?.slice(0, 10000) ?? null,
          path: window.location.pathname.slice(0, 2000),
        }),
      }).catch(() => {});
    } catch {
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[50dvh] flex flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-lg font-semibold">Stránku se nepodařilo načíst</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            Došlo k neočekávané chybě. Zkuste obnovit stránku nebo se vraťte zpět.
          </p>
          <div className="flex gap-2">
            <button
              onClick={this.handleReset}
              className="px-4 py-2 text-sm rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Zkusit znovu
            </button>
            <button
              onClick={this.handleReload}
              className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Obnovit stránku
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Automatická obnova: data se sama načtou znovu, když se uživatel vrátí
      // do aplikace nebo obnoví připojení. Žádný polling (refetchInterval) –
      // šetrné na mobilní data. Krátký staleTime, aby měl refetch při fokusu
      // smysl, ale rychlé přepínání obrazovek zbytečně nezatěžovalo síť.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 30 * 1000,
    },
  },
});

function PermissionOnly({ component: Component, permission }: { component: React.ComponentType; permission: Permission }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <div className="p-8 text-center">
        <p className="text-lg font-semibold mb-2">Přístup odepřen</p>
        <p className="text-sm text-muted-foreground">Pro tento modul nemáte potřebné oprávnění.</p>
      </div>
    );
  }
  return <Component />;
}

function AuthenticatedApp() {
  // Keep open screens live with changes made on other devices (SSE push).
  // Only active while authenticated, so the stream is never opened on /login.
  useLiveUpdates();
  return (
    <OfflineQueueProvider>
    <QuickAddDateProvider>
      <Layout>
        <OfflineBanner />
        <PageErrorBoundary>
        <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/calendar" component={Calendar} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/jobs/new" component={JobForm} />
        <Route path="/jobs/:id/list" component={JobExport} />
        <Route path="/jobs/:id" component={JobDetail} />
        <Route path="/job-groups" component={JobGroups} />
        <Route path="/job-groups/:id/list" component={JobGroupExport} />
        <Route path="/job-groups/:id" component={JobGroupDetail} />
        <Route path="/customers" component={Customers} />
        <Route path="/customers/:id" component={CustomerDetail} />
        <Route path="/customer-sites/:id" component={SiteDetail} />
        <Route path="/pristupove-udaje/export/:id">{() => <PermissionOnly component={PristupoveUdajeExport} permission="credentials.view" />}</Route>
        <Route path="/pristupove-udaje">{() => <PermissionOnly component={PristupoveUdaje} permission="credentials.view" />}</Route>
        <Route path="/people" component={People} />
        <Route path="/people/:id" component={PersonDetail} />
        <Route path="/sklad/pohyby" component={SkladPohyby} />
        <Route path="/sklad" component={Sklad} />
        <Route path="/stroje" component={Stroje} />
        <Route path="/stroje/oopp" component={Oopp} />
        <Route path="/oopp/moje" component={OoppMoje} />
        <Route path="/stroje/:id" component={StrojDetail} />
        <Route path="/activities" component={Activities} />
        <Route path="/activities/:id/export" component={ActivityExport} />
        <Route path="/activities/:id" component={ActivityDetail} />
        <Route path="/me" component={MyOverview} />
        <Route path="/settings" component={Settings} />
        <Route path="/admin" component={Admin} />
        <Route path="/statistika">{() => <PermissionOnly component={Statistika} permission="statistics.view" />}</Route>
        <Route path="/billing/bank-import">{() => <PermissionOnly component={BillingBankImport} permission="billing.manage" />}</Route>
        <Route path="/billing/settings">{() => <PermissionOnly component={BillingSettings} permission="billing.settings" />}</Route>
        <Route path="/billing/documents/review">{() => <PermissionOnly component={BillingReviewQueue} permission="billing.approve" />}</Route>
        <Route path="/billing/documents/:id">{() => <PermissionOnly component={BillingDocumentDetail} permission="billing.view" />}</Route>
        <Route path="/billing/documents">{() => <PermissionOnly component={BillingDocuments} permission="billing.view" />}</Route>
        <Route path="/billing/email-import">{() => <PermissionOnly component={BillingEmailImport} permission="billing.settings" />}</Route>
        <Route path="/billing/unbilled/:customerId">{() => <PermissionOnly component={BillingUnbilledDetail} permission="billing.view" />}</Route>
        <Route path="/billing/unbilled">{() => <PermissionOnly component={BillingUnbilled} permission="billing.view" />}</Route>
        <Route path="/billing/invoices/:id/edit">{() => <PermissionOnly component={BillingInvoiceEdit} permission="billing.manage" />}</Route>
        <Route path="/billing/invoices/:id">{() => <PermissionOnly component={BillingInvoiceDetail} permission="billing.view" />}</Route>
        <Route path="/billing/invoices">{() => <PermissionOnly component={BillingInvoices} permission="billing.view" />}</Route>
        <Route path="/billing/recurring-templates/:id">{() => <PermissionOnly component={BillingRecurringTemplateDetail} permission="billing.manage" />}</Route>
        <Route path="/billing/recurring-templates">{() => <PermissionOnly component={BillingRecurringTemplates} permission="billing.manage" />}</Route>
        <Route path="/billing">{() => <PermissionOnly component={Billing} permission="billing.view" />}</Route>
        <Route path="/admin/users">{() => <PermissionOnly component={UsersAdmin} permission="users.manage" />}</Route>
        <Route path="/admin/audit">{() => <PermissionOnly component={AuditLog} permission="audit.view" />}</Route>
        <Route path="/admin/client-errors">{() => <PermissionOnly component={ClientErrors} permission="diagnostics.view" />}</Route>
        <Route path="/admin/gdpr">{() => <PermissionOnly component={Gdpr} permission="settings.manage" />}</Route>
        <Route path="/admin/health">{() => <PermissionOnly component={AdminHealth} permission="diagnostics.view" />}</Route>
        <Route path="/admin/sessions">{() => <PermissionOnly component={AdminSessions} permission="users.manage" />}</Route>
        <Route path="/admin/warehouse-backfill">{() => <PermissionOnly component={AdminWarehouseBackfill} permission="warehouse.manage" />}</Route>
        <Route path="/quotes/new">{() => <PermissionOnly component={QuoteDetail} permission="quotes.manage" />}</Route>
        <Route path="/quotes/:id">{() => <PermissionOnly component={QuoteDetail} permission="quotes.view" />}</Route>
        <Route path="/quotes">{() => <PermissionOnly component={Quotes} permission="quotes.view" />}</Route>
        <Route component={NotFound} />
        </Switch>
        </PageErrorBoundary>
      </Layout>
    </QuickAddDateProvider>
    </OfflineQueueProvider>
  );
}

function Router() {
  const [path] = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  // Public pages — accessible without authentication
  if (path.startsWith("/sign/")) {
    return <JobSign />;
  }
  if (path.startsWith("/oopp/sign/")) {
    return <OoppSign />;
  }
  if (path.startsWith("/quote-share/")) {
    return <QuoteShare />;
  }
  if (path === "/oopp/potvrdit" || path.startsWith("/oopp/potvrdit?")) {
    return <PpeConfirm />;
  }
  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center text-muted-foreground">
        Načítám…
      </div>
    );
  }
  if (!isAuthenticated) return <Login />;
  return <AuthenticatedApp />;
}

function App() {
  useEffect(() => {
    const s = loadCompanySettings();
    applyTextColor(s.textColor);
    applyUiScale(s.uiScale);
  }, []);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthProvider>
              <Router />
            </AuthProvider>
          </WouterRouter>
          <Toaster />
          <PwaUpdatePrompt />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
