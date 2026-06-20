import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { loadCompanySettings, applyTextColor, applyUiScale } from "@/lib/company-settings";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { QuickAddDateProvider } from "@/hooks/use-quick-add-date";

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
import Stroje from "@/pages/stroje";
import StrojDetail from "@/pages/stroj-detail";
import AuditLog from "@/pages/audit-log";
import Gdpr from "@/pages/gdpr";
import Statistika from "@/pages/statistika";
import Billing from "@/pages/billing";
import BillingUnbilled from "@/pages/billing-unbilled";
import BillingUnbilledDetail from "@/pages/billing-unbilled-detail";
import BillingInvoices from "@/pages/billing-invoices";
import BillingInvoiceDetail from "@/pages/billing-invoice-detail";
import BillingInvoiceEdit from "@/pages/billing-invoice-edit";
import BillingSettings from "@/pages/billing-settings";
import PwaUpdatePrompt from "@/components/pwa-update-prompt";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
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
  return (
    <QuickAddDateProvider>
      <Layout>
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
        <Route path="/sklad" component={Sklad} />
        <Route path="/stroje" component={Stroje} />
        <Route path="/stroje/:id" component={StrojDetail} />
        <Route path="/activities" component={Activities} />
        <Route path="/activities/:id/export" component={ActivityExport} />
        <Route path="/activities/:id" component={ActivityDetail} />
        <Route path="/me" component={MyOverview} />
        <Route path="/settings" component={Settings} />
        <Route path="/admin" component={Admin} />
        <Route path="/statistika">{() => <AdminOnly component={Statistika} />}</Route>
        <Route path="/billing/settings">{() => <AdminOnly component={BillingSettings} />}</Route>
        <Route path="/billing/unbilled/:customerId">{() => <AdminOnly component={BillingUnbilledDetail} />}</Route>
        <Route path="/billing/unbilled">{() => <AdminOnly component={BillingUnbilled} />}</Route>
        <Route path="/billing/invoices/:id/edit">{() => <AdminOnly component={BillingInvoiceEdit} />}</Route>
        <Route path="/billing/invoices/:id">{() => <AdminOnly component={BillingInvoiceDetail} />}</Route>
        <Route path="/billing/invoices">{() => <AdminOnly component={BillingInvoices} />}</Route>
        <Route path="/billing">{() => <AdminOnly component={Billing} />}</Route>
        <Route path="/admin/users">{() => <AdminOnly component={UsersAdmin} />}</Route>
        <Route path="/admin/audit">{() => <AdminOnly component={AuditLog} />}</Route>
        <Route path="/admin/gdpr">{() => <AdminOnly component={Gdpr} />}</Route>
        <Route component={NotFound} />
        </Switch>
      </Layout>
    </QuickAddDateProvider>
  );
}

function Router() {
  const { isAuthenticated, isLoading } = useAuth();
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
