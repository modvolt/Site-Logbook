import { createRoot } from "react-dom/client";
import App from "./App";
import { installIdentityFetchGuard } from "@/lib/identity-fetch";
import {
  bootstrapPublicGrantLocation,
  installPublicGrantNavigationGuard,
} from "@/lib/public-grant-bootstrap";
import "./index.css";

bootstrapPublicGrantLocation();
installPublicGrantNavigationGuard();
installIdentityFetchGuard();
createRoot(document.getElementById("root")!).render(<App />);
