/**
 * app/api/inngest/route.ts
 * Inngest serve handler — receives event delivery from Inngest Cloud.
 * Register all functions here.
 */
import { serve } from "inngest/next";
import { inngest } from "@/src/lib/inngest";
import {
  handleUploadFinalized,
  handleUploadScanned,
  handlePayloadCompleted,
  handleAgentRun,
} from "@/src/lib/inngest-functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    handleUploadFinalized,
    handleUploadScanned,
    handlePayloadCompleted,
    handleAgentRun,
  ],
});
