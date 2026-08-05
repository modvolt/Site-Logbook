import { lazy, Suspense, useEffect, Component, type ReactNode, type ErrorInfo } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { loadCompanySettings, applyTextColor, applyUiScale } from "@/lib/company-settings";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { AuthProvider, useAuth, type Permission } from "@/hooks/use-auth";
import { QuickAddDateProvider } from "@/hooks/use-quick-add-date";
import { useLiveUpdates } from "@/hooks/use-live-updates";
import { OfflineQueueProvider } from "@/hooks/use-offline-queue";
import { OfflineBanner } from "@/components/offline-banner";
import PwaUpdatePrompt from "@/components/pwa-update-prompt";
import {
  isPublicGrantRoutePath,
  retainPublicGrantForRoutePath,
} from "@/lib/public-grant-bootstrap";

const NotFound = lazy(() => import("@/pages/not-found"));
const OoppSign = lazy(() => import("@/pages/oopp-sign"));
const JobSign = lazy(() => import("@/pages/job-sign"));
const QuoteShare = lazy(() => import("@/pages/quote-share"));
const SwitchboardPublic = lazy(() => import("@/pages/switchboard-public"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const FieldHome = lazy(() => import("@/pages/field-home"));
const Calendar = lazy(() => import("@/pages/calendar"));
const Jobs = lazy(() => import("@/pages/jobs"));
const JobDetail = lazy(() => import("@/pages/job-detail"));
const JobExport = lazy(() => import("@/pages/job-export"));
const JobForm = lazy(() => import("@/pages/job-form"));
const JobGroups = lazy(() => import("@/pages/job-groups"));
const JobGroupDetail = lazy(() => import("@/pages/job-group-detail"));
const JobGroupExport = lazy(() => import("@/pages/job-group-export"));
const Switchboards = lazy(() => import("@/pages/switchboards"));
const SwitchboardDetail = lazy(() => import("@/pages/switchboard-detail"));
const SwitchboardParserSettings = lazy(() => import("@/pages/switchboard-parser-settings"));
const SwitchboardTemplateSettings = lazy(() => import("@/pages/switchboard-template-settings"));
const SwitchboardAudit = lazy(() => import("@/pages/switchboard-audit"));
const People = lazy(() => import("@/pages/people"));
const Customers = lazy(() => import("@/pages/customers"));
const CustomerDetail = lazy(() => import("@/pages/customer-detail"));
const SiteDetail = lazy(() => import("@/pages/site-detail"));
const PristupoveUdaje = lazy(() => import("@/pages/pristupove-udaje"));
const PristupoveUdajeExport = lazy(() => import("@/pages/pristupove-udaje-export"));
const Settings = lazy(() => import("@/pages/settings"));
const Admin = lazy(() => import("@/pages/admin"));
const Login = lazy(() => import("@/pages/login"));
const UsersAdmin = lazy(() => import("@/pages/users-admin"));
const Activities = lazy(() => import("@/pages/activities"));
const ActivityDetail = lazy(() => import("@/pages/activity-detail"));
const ActivityExport = lazy(() => import("@/pages/activity-export"));
const MyOverview = lazy(() => import("@/pages/my-overview"));
const Sklad = lazy(() => import("@/pages/sklad"));
const SkladPohyby = lazy(() => import("@/pages/sklad-pohyby"));
const Stroje = lazy(() => import("@/pages/stroje"));
const StrojDetail = lazy(() => import("@/pages/stroj-detail"));
const Oopp = lazy(() => import("@/pages/oopp"));
const OoppMoje = lazy(() => import("@/pages/oopp-moje"));
const PpeConfirm = lazy(() => import("@/pages/ppe-confirm"));
const PersonDetail = lazy(() => import("@/pages/person-detail"));
const AuditLog = lazy(() => import("@/pages/audit-log"));
const ClientErrors = lazy(() => import("@/pages/client-errors"));
const Gdpr = lazy(() => import("@/pages/gdpr"));
const Statistika = lazy(() => import("@/pages/statistika"));
const Billing = lazy(() => import("@/pages/billing"));
const BillingUnbilled = lazy(() => import("@/pages/billing-unbilled"));
const BillingUnbilledDetail = lazy(() => import("@/pages/billing-unbilled-detail"));
const BillingInvoices = lazy(() => import("@/pages/billing-invoices"));
const BillingInvoiceDetail = lazy(() => import("@/pages/billing-invoice-detail"));
const BillingInvoiceEdit = lazy(() => import("@/pages/billing-invoice-edit"));
const BillingSettings = lazy(() => import("@/pages/billing-settings"));
const BillingBankImport = lazy(() => import("@/pages/billing-bank-import"));
const BillingDocuments = lazy(() => import("@/pages/billing-documents"));
const BillingDocumentDetail = lazy(() => import("@/pages/billing-document-detail"));
const BillingReviewQueue = lazy(() => import("@/pages/billing-review-queue"));
const BillingEmailImport = lazy(() => import("@/pages/billing-email-import"));
const BillingRecurringTemplates = lazy(() => import("@/pages/billing-recurring-templates"));
const BillingRecurringTemplateDetail = lazy(() => import("@/pages/billing-recurring-template-detail"));
const AdminHealth = lazy(() => import("@/pages/admin-health"));
const AdminSessions = lazy(() => import("@/pages/admin-sessions"));
const AdminWarehouseBackfill = lazy(() => import("@/pages/admin-warehouse-backfill"));
const Quotes = lazy(() => import("@/pages/quotes"));
const QuoteDetail = lazy(() => import("@/pages/quote-detail"));
const ExternalPortal = lazy(() => import("@/pages/external-portal"));
const ExternalAccountsAdmin = lazy(() => import("@/pages/external-accounts-admin"));

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function PageLoading() {
  return (
    <div className="min-h-[50dvh] flex items-center justify-center text-muted-foreground">
      Načítám…
    </div>
  );
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

function PermissionOnly({ component: Component, permission }: { component: React.ComponentType; permission: Permission | readonly Permission[] }) {
  const { can } = useAuth();
  const required = Array.isArray(permission) ? permission : [permission];
  if (!required.every((item) => can(item))) {
    return (
      <div className="p-8 text-center">
        <p className="text-lg font-semibold mb-2">Přístup odepřen</p>
        <p className="text-sm text-muted-foreground">Pro tento modul nemáte potřebné oprávnění.</p>
      </div>
    );
  }
  return <Component />;
}

function HomePage() {
  const { can } = useAuth();
  if (!can("jobs.view")) {
    return <PermissionOnly component={Dashboard} permission="jobs.view" />;
  }
  return can("jobs.work") && !can("jobs.manage") ? <FieldHome /> : <Dashboard />;
}

function AuthenticatedApp() {
  const [path] = useLocation();
  // Keep open screens live with changes made on other devices (SSE push).
  // Only active while authenticated, so the stream is never opened on /login.
  useLiveUpdates();
  return (
    <OfflineQueueProvider>
    <QuickAddDateProvider>
      <Layout>
        <OfflineBanner />
        <PageErrorBoundary key={path}>
        <Suspense fallback={<PageLoading />}>
        <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/calendar">{() => <PermissionOnly component={Calendar} permission="jobs.view" />}</Route>
        <Route path="/jobs">{() => <PermissionOnly component={Jobs} permission="jobs.view" />}</Route>
        <Route path="/jobs/new">{() => <PermissionOnly component={JobForm} permission={["jobs.view", "jobs.manage"]} />}</Route>
        <Route path="/jobs/:id/list">{() => <PermissionOnly component={JobExport} permission={["jobs.view", "jobs.manage"]} />}</Route>
        <Route path="/jobs/:id">{() => <PermissionOnly component={JobDetail} permission="jobs.view" />}</Route>
        <Route path="/job-groups">{() => <PermissionOnly component={JobGroups} permission="jobs.view" />}</Route>
        <Route path="/job-groups/:id/list">{() => <PermissionOnly component={JobGroupExport} permission="jobs.view" />}</Route>
        <Route path="/job-groups/:id">{() => <PermissionOnly component={JobGroupDetail} permission="jobs.view" />}</Route>
        <Route path="/switchboards/:id">{() => <PermissionOnly component={SwitchboardDetail} permission="switchboards.view" />}</Route>
        <Route path="/switchboards">{() => <PermissionOnly component={Switchboards} permission="switchboards.view" />}</Route>
        <Route path="/admin/switchboard-parser">{() => <PermissionOnly component={SwitchboardParserSettings} permission="switchboards.parser.manage" />}</Route>
        <Route path="/admin/switchboard-templates">{() => <PermissionOnly component={SwitchboardTemplateSettings} permission="switchboards.templates.manage" />}</Route>
        <Route path="/admin/switchboard-audit">{() => <PermissionOnly component={SwitchboardAudit} permission="switchboards.audit.view" />}</Route>
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
        <Route path="/admin">{() => <PermissionOnly component={Admin} permission={["jobs.view", "jobs.manage"]} />}</Route>
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
        <Route path="/admin/external-accounts">{() => <PermissionOnly component={ExternalAccountsAdmin} permission="users.manage" />}</Route>
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
        </Suspense>
        </PageErrorBoundary>
      </Layout>
    </QuickAddDateProvider>
    </OfflineQueueProvider>
  );
}

function Router() {
  const [path] = useLocation();
  const { isAuthenticated, isLoading, user } = useAuth();
  const pathname = path.split("?", 1)[0];
  retainPublicGrantForRoutePath(pathname);
  // Public pages — credentials were captured before React mounted.
  if (pathname === "/sign") {
    return <JobSign />;
  }
  if (pathname === "/oopp/sign") {
    return <OoppSign />;
  }
  if (pathname === "/quote-share") {
    return <QuoteShare />;
  }
  if (pathname === "/q/board") {
    return <SwitchboardPublic />;
  }
  if (pathname === "/oopp/potvrdit") {
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
  if (user?.accountType === "external") return <ExternalPortal />;
  return <AuthenticatedApp />;
}

function PublicAwarePwaUpdatePrompt() {
  const [path] = useLocation();
  const { user } = useAuth();
  return isPublicGrantRoutePath(path.split("?", 1)[0]) || user?.accountType === "external"
    ? null
    : <PwaUpdatePrompt />;
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
              <PageErrorBoundary>
                <Suspense fallback={<PageLoading />}>
                  <Router />
                </Suspense>
              </PageErrorBoundary>
            </AuthProvider>
            <PublicAwarePwaUpdatePrompt />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
