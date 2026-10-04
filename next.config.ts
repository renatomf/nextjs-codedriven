import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// @huggingface/transformers loads onnxruntime-node with a dynamic require
// (`requireFromHere("onnxruntime-node")`), and the binding loads
// libonnxruntime.so via dlopen: file tracing sees neither, so both the JS
// package and the Linux x64 binaries are listed by hand. Only the CPU
// runtime: on Linux x64 the package's postinstall also downloads the CUDA and
// TensorRT providers (~258 MiB), which Vercel cannot use (TD-41).
const ONNX_RUNTIME_FILES = [
  "./node_modules/onnxruntime-node/package.json",
  "./node_modules/onnxruntime-node/dist/**/*",
  "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1",
  "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
  "./node_modules/onnxruntime-common/package.json",
  "./node_modules/onnxruntime-common/dist/cjs/**/*",
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  serverExternalPackages: [
    "tree-sitter",
    "tree-sitter-javascript",
    "tree-sitter-typescript",
    "@huggingface/transformers",
    "onnxruntime-node",
    "sharp",
  ],
  experimental: {
    serverActions: {
      // A 4 MB ZIP plus the multipart envelope. Vercel caps any function's
      // request body at 4.5 MB anyway (TD-45): a bigger limit here was a
      // promise the platform could not keep.
      bodySizeLimit: "5mb",
    },
    // Reuse visited dynamic pages for 30s in the client cache, so switching
    // back and forth between project tabs is instant. Server Actions that
    // call revalidatePath still clear it right away.
    staleTimes: {
      dynamic: 30,
    },
  },
  // Only the two functions that create embeddings get the ONNX runtime: the
  // workflow function, where the analysis steps run (ADR-005), and the chat.
  // The binary is 46 MB: adding it to more routes stops Vercel from grouping
  // them, and the Hobby plan caps a deployment at 12 functions.
  outputFileTracingIncludes: {
    "/.well-known/workflow/v1/flow": ONNX_RUNTIME_FILES,
    "/api/chat": ONNX_RUNTIME_FILES,
  },
  // Never ship: a locally downloaded model cache (it is fetched at runtime),
  // tree-sitter C sources, native binaries for other platforms, and the ONNX
  // GPU providers.
  outputFileTracingExcludes: {
    "/*": [
      "./node_modules/@huggingface/transformers/.cache/**/*",
      "./node_modules/tree-sitter-*/src/**/*",
      "./node_modules/tree-sitter-*/prebuilds/!(linux-x64)/**/*",
      "./node_modules/onnxruntime-node/bin/napi-v6/!(linux)/**/*",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**/*",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_*.so",
    ],
  },
  poweredByHeader: false,
  // Baseline security headers, enforced. No Content-Security-Policy here: on
  // Vercel these headers also reach the page render, and Next.js reads the
  // CSP nonce from that request header, so a static policy hid the proxy's
  // nonce (2026-10-04). The proxy sends the CSP (src/proxy.ts, TD-34).
  headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Clickjacking: the app is never embedded in an iframe (pages also
          // get `frame-ancestors 'none'` from the proxy).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
      {
        // Public shared reports: the token is in the URL. Later entries
        // override the same key above (Referrer-Policy).
        source: "/r/:token",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};

export default withWorkflow(nextConfig);
