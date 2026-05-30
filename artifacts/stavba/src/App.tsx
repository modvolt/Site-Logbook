import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { AuthProvider, useAuth } from "@/hooks/use-auth";

import Dashboard from "@/pages/dashboard";
import Calendar from "@/pages/calendar";
import Jobs from "@/pages/jobs";
import JobDetail from "@/pages/job-detail";
import JobExport from "@/pages/job-export";
import JobForm from "@/pages/job-form";
import People from "@/pages/people";
import Customers from "@/pages/customers";
import CustomerDetail from "@/pages/customer-detail";
import Settings from "@/pages/settings";
import Admin from "@/pages/admin";
import Login from "@/pages/login";
import UsersAdmin from "@/pages/users-admin";
import Activities from "@/pages/activities";
import ActivityDetail from "@/pages/activity-detail";
import MyOverview from "@/pages/my-overview";

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

function AuthenticatedApp() {
  return (
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
        <Route path="/people" component={People} />
        <Route path="/activities" component={Activities} />
        <Route path="/activities/:id" component={ActivityDetail} />
        <Route path="/me" component={MyOverview} />
        <Route path="/settings" component={Settings} />
        <Route path="/admin" component={Admin} />
        <Route path="/admin/users">{() => <AdminOnly component={UsersAdmin} />}</Route>
        <Route component={NotFound} />
      </Switch>
    </Layout>
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
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
