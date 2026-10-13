# Source-available core distribution

The maintained core lives in `dashideyizhizuo-hash/bridge-core`; new core changes
and issues belong here. The original private `bridge` repository is retained as
historical evidence, with remaining operated-service work tracked privately.
Use an explicitly selected runtime repository and exact SHA when onboarding
engineering projects. Historical pinned actions can remain readable in the
archive; migrate those pins through each project's policy and verification flow.

The Host, MCP/Cloudflare server, authorization, execution and file transport are provided under the unmodified Elastic License 2.0 in LICENSE. This is source-available, not OSI open source. Commercial billing, payment integrations and the hosted account console are not included.

This export has independent history. Do not publish or mirror the original private repositories, their branches, PR history or artifacts. Keep third-party dependency notices intact.

Before distribution, run the core boundary check, tests and package verification. CI covers Windows, Linux, and macOS on Apple Silicon and Intel with Node.js 22/24. Check the exact candidate run before claiming acceptance; real desktop login/logout and reboot remain separate checks. See SELF_HOSTED_CONFIGURATION.md for required operator configuration.
