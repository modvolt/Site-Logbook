import { useEffect, Component, type ReactNode, type ErrorInfo } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { loadCompanySettings, applyTextColor, applyUiScale } from "@/lib/company-settings";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { QuickAddDateProvider } from "@/hooks/use-quick-add-date";
import { useLiveUpdates } from "@/hooks/use-live-updates";
import OoppSign from "@/pages/oopp-sign";

import Dashboard from "@/pages/dashboard";
import Calendar from "@/pages/calendar";
import Jobs from "@/pages/jobs";
import JobDetail from "@/pages/job-detail";
import JobExport from "@/pages/job-export";
import JobForm from "@/pages/job-form";
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
import AdminHealth from "@/pages/admin-health";
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

function AdminOnly({ component: Component }: { component: React.ComponentType }) {
  const { can } = useAuth();
  if (!can("manageUsers")) {
    return (
      <div className="p-8 text-center">
        <p className="text-lg font-semibold mb-2">Přístup odepřen</p>
        <p className="text-sm text-muted-foreground">Tato stránka je dostupná pouze pro administrátory.</p>
      </div>
    );
  }
  return <Component />;
}

function WriteOnly({ component: Component }: { component: React.ComponentType }) {
  const { can } = useAuth();
  if (!can("write")) {
    return (
      <div className="p-8 text-center">
        <p className="text-lg font-semibold mb-2">Přístup odepřen</p>
        <p className="text-sm text-muted-foreground">Tato stránka není dostupná pro hosty.</p>
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
    <QuickAddDateProvider>
      <Layout>
        <PageErrorBoundary>
        <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/calendar" component={Calendar} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/jobs/new" component={JobForm} />
        <Route path="/jobs/:id/list" component={JobExport} />
        <Route path="/jobs/:id" component={JobDetail} />
        <Route path="/customers" component={Customers} />
        <Route path="/customers/:id" component={CustomerDetail} />
        <Route path="/customer-sites/:id" component={SiteDetail} />
        <Route path="/pristupove-udaje/export/:id">{() => <WriteOnly component={PristupoveUdajeExport} />}</Route>
        <Route path="/pristupove-udaje">{() => <WriteOnly component={PristupoveUdaje} />}</Route>
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
        <Route path="/statistika">{() => <AdminOnly component={Statistika} />}</Route>
        <Route path="/billing/bank-import">{() => <AdminOnly component={BillingBankImport} />}</Route>
        <Route path="/billing/settings">{() => <AdminOnly component={BillingSettings} />}</Route>
        <Route path="/billing/documents/review">{() => <AdminOnly component={BillingReviewQueue} />}</Route>
        <Route path="/billing/documents/:id">{() => <AdminOnly component={BillingDocumentDetail} />}</Route>
        <Route path="/billing/documents">{() => <AdminOnly component={BillingDocuments} />}</Route>
        <Route path="/billing/email-import">{() => <AdminOnly component={BillingEmailImport} />}</Route>
        <Route path="/billing/unbilled/:customerId">{() => <AdminOnly component={BillingUnbilledDetail} />}</Route>
        <Route path="/billing/unbilled">{() => <AdminOnly component={BillingUnbilled} />}</Route>
        <Route path="/billing/invoices/:id/edit">{() => <AdminOnly component={BillingInvoiceEdit} />}</Route>
        <Route path="/billing/invoices/:id">{() => <AdminOnly component={BillingInvoiceDetail} />}</Route>
        <Route path="/billing/invoices">{() => <AdminOnly component={BillingInvoices} />}</Route>
        <Route path="/billing">{() => <AdminOnly component={Billing} />}</Route>
        <Route path="/admin/users">{() => <AdminOnly component={UsersAdmin} />}</Route>
        <Route path="/admin/audit">{() => <AdminOnly component={AuditLog} />}</Route>
        <Route path="/admin/client-errors">{() => <AdminOnly component={ClientErrors} />}</Route>
        <Route path="/admin/gdpr">{() => <AdminOnly component={Gdpr} />}</Route>
        <Route path="/admin/health">{() => <WriteOnly component={AdminHealth} />}</Route>
        <Route component={NotFound} />
        </Switch>
        </PageErrorBoundary>
      </Layout>
    </QuickAddDateProvider>
  );
}

function Router() {
  const [path] = useLocation();
  // Public sign page — accessible without authentication
  if (path.startsWith("/oopp/sign/")) {
    return <OoppSign />;
  }
  const { isAuthenticated, isLoading } = useAuth();
  const [location] = useLocation();

  if (location === "/oopp/potvrdit" || location.startsWith("/oopp/potvrdit?")) {
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
