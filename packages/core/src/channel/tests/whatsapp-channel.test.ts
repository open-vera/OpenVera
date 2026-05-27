/**
 * WhatsApp Business API Channel Adapter Tests.
 *
 * Covers:
 *   - Constructor validation
 *   - Lifecycle (connect/disconnect)
 *   - Message sending via WhatsApp Cloud API
 *   - Webhook verification (GET)
 *   - Webhook event handling (POST: text, image, document, audio, video, location, reaction)
 *   - Signature verification (X-Hub-Signature-256)
 *   - History filtering
 *   - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

// ── Selective fetch mock — only intercepts Meta Graph API calls ──────────────

const originalFetch = globalThis.fetch;
const mockApiFetch = vi.fn();

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url && url.includes("graph.facebook.com")) {
    return mockApiFetch(input, init);
  }
  return originalFetch(input, init);
});

describe("WhatsAppChannelAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function importAdapter() {
    const { WhatsAppChannelAdapter } = await import("../whatsapp-channel.js");
    return WhatsAppChannelAdapter;
  }

  function mockValidateToken() {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "PHONE_ID", display_phone_number: "+1234567890" }),
    });
  }

  function mockSendMessageResponse(messageId = "wamid.HBgLMTIzNDU2Nzg5MCE=") {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messaging_product: "whatsapp",
        contacts: [{ input: "+1234567890", wa_id: "1234567890" }],
        messages: [{ id: messageId }],
      }),
    });
  }

  function makeSignature(appSecret: string, body: Buffer): string {
    return `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
  }

  // ── Constructor validation ─────────────────────────────────────────────────

  it("should throw if accessToken is missing", async () => {
    const Adapter = await importAdapter();
    expect(
      () =>
        new Adapter({
          accessToken: "",
          phoneNumberId: "123",
          businessAccountId: "456",
          verifyToken: "token",
        }),
    ).toThrow("accessToken is required");
  });

  it("should throw if phoneNumberId is missing", async () => {
    const Adapter = await importAdapter();
    expect(
      () =>
        new Adapter({
          accessToken: "token",
          phoneNumberId: "",
          businessAccountId: "456",
          verifyToken: "token",
        }),
    ).toThrow("phoneNumberId is required");
  });

  it("should throw if businessAccountId is missing", async () => {
    const Adapter = await importAdapter();
    expect(
      () =>
        new Adapter({
          accessToken: "token",
          phoneNumberId: "123",
          businessAccountId: "",
          verifyToken: "token",
        }),
    ).toThrow("businessAccountId is required");
  });

  it("should throw if verifyToken is missing", async () => {
    const Adapter = await importAdapter();
    expect(
      () =>
        new Adapter({
          accessToken: "token",
          phoneNumberId: "123",
          businessAccountId: "456",
          verifyToken: "",
        }),
    ).toThrow("verifyToken is required");
  });

  it("should have correct name and channelType", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "123",
      businessAccountId: "456",
      verifyToken: "verify",
    });
    expect(adapter.name).toBe("whatsapp");
    expect(adapter.channelType).toBe("whatsapp");
    await adapter.disconnect();
  });

  it("should start in disconnected state", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "123",
      businessAccountId: "456",
      verifyToken: "verify",
    });
    expect(adapter.state).toBe("disconnected");
    expect(adapter.getStatus().state).toBe("disconnected");
    await adapter.disconnect();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  it("should connect and transition to connected state", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "123",
      businessAccountId: "456",
      verifyToken: "verify",
    });

    mockValidateToken();
    await adapter.connect();
    expect(adapter.state).toBe("connected");
    expect(adapter.port).toBeGreaterThan(0);

    await adapter.disconnect();
    expect(adapter.state).toBe("disconnected");
  });

  it("should throw ChannelConnectionError when token validation fails", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "bad-token",
      phoneNumberId: "123",
      businessAccountId: "456",
      verifyToken: "verify",
    });

    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({
        error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 },
      }),
    });

    await expect(adapter.connect()).rejects.toThrow("Connection failed");
  });

  // ── Message sending ────────────────────────────────────────────────────────

  it("should send text messages via WhatsApp Cloud API", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "test-token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    mockValidateToken();
    await adapter.connect();

    mockSendMessageResponse();

    const result = await adapter.sendMessage({
      content: "Hello from WhatsApp!",
      channelOptions: { to: "+1234567890" },
    });

    expect(result.content).toBe("Hello from WhatsApp!");
    expect(result.senderId).toBe("bot");

    expect(mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining("PHONE_ID/messages"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );

    await adapter.disconnect();
  });

  it("should throw if 'to' is missing when sending", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    mockValidateToken();
    await adapter.connect();

    await expect(adapter.sendMessage({ content: "Hello" })).rejects.toThrow("to (recipient phone number) is required");

    await adapter.disconnect();
  });

  it("should throw if not connected when sending", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    await expect(
      adapter.sendMessage({ content: "Hello", channelOptions: { to: "+123" } }),
    ).rejects.toThrow("not connected");
  });

  it("should send image messages with media URL", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    mockValidateToken();
    await adapter.connect();

    mockSendMessageResponse("wamid-image-001");

    const result = await adapter.sendMessage({
      content: "Check this image",
      channelOptions: {
        to: "+123",
        messageType: "image",
        mediaUrl: "https://example.com/photo.jpg",
      },
    });

    expect(result.content).toBe("Check this image");

    // Verify the API call body contained image type
    const callBody = JSON.parse(mockApiFetch.mock.calls[1][1].body as string);
    expect(callBody.type).toBe("image");
    expect(callBody.image.link).toBe("https://example.com/photo.jpg");

    await adapter.disconnect();
  });

  it("should send document messages", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    mockValidateToken();
    await adapter.connect();

    mockSendMessageResponse("wamid-doc-001");

    const result = await adapter.sendMessage({
      content: "Here's the document",
      channelOptions: {
        to: "+123",
        messageType: "document",
        mediaId: "MEDIA_ID_123",
        filename: "report.pdf",
      },
    });

    expect(result.content).toBe("Here's the document");

    const callBody = JSON.parse(mockApiFetch.mock.calls[1][1].body as string);
    expect(callBody.type).toBe("document");
    expect(callBody.document.id).toBe("MEDIA_ID_123");
    expect(callBody.document.filename).toBe("report.pdf");

    await adapter.disconnect();
  });

  it("should send location messages", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    mockValidateToken();
    await adapter.connect();

    mockSendMessageResponse("wamid-loc-001");

    await adapter.sendMessage({
      content: "Here's the location",
      channelOptions: {
        to: "+123",
        messageType: "location",
        latitude: 37.7749,
        longitude: -122.4194,
        locationName: "San Francisco",
      },
    });

    const callBody = JSON.parse(mockApiFetch.mock.calls[1][1].body as string);
    expect(callBody.type).toBe("location");
    expect(callBody.location.latitude).toBe(37.7749);
    expect(callBody.location.longitude).toBe(-122.4194);

    await adapter.disconnect();
  });

  // ── Webhook verification (GET) ─────────────────────────────────────────────

  it("should handle webhook verification with correct token", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "my-verify-token",
    });

    mockValidateToken();
    await adapter.connect();

    const port = adapter.port;
    const resp = await fetch(
      `http://127.0.0.1:${port}/whatsapp/webhook?hub.mode=subscribe&hub.challenge=test-challenge&hub.verify_token=my-verify-token`,
    );

    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toBe("test-challenge");

    await adapter.disconnect();
  });

  it("should reject webhook verification with wrong token", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "correct-token",
    });

    mockValidateToken();
    await adapter.connect();

    const port = adapter.port;
    const resp = await fetch(
      `http://127.0.0.1:${port}/whatsapp/webhook?hub.mode=subscribe&hub.challenge=challenge&hub.verify_token=wrong-token`,
    );

    expect(resp.status).toBe(403);

    await adapter.disconnect();
  });

  // ── Webhook event handling (POST) ──────────────────────────────────────────

  it("should handle incoming text messages", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    const messages: Array<{ content: string; senderId: string }> = [];
    adapter.onMessage((msg) => {
      messages.push({ content: msg.content, senderId: msg.senderId });
    });

    mockValidateToken();
    await adapter.connect();

    const port = adapter.port;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "BIZ_ID",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "+1234567890", phone_number_id: "PHONE_ID" },
                contacts: [{ wa_id: "9876543210", profile: { name: "John" } }],
                messages: [
                  {
                    from: "9876543210",
                    id: "wamid-msg-001",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Hello from WhatsApp!" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const resp = await fetch(`http://127.0.0.1:${port}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(resp.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello from WhatsApp!");
    expect(messages[0].senderId).toBe("9876543210");

    const history = await adapter.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].senderName).toBe("John");

    await adapter.disconnect();
  });

  it("should handle image messages", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    const messages: Array<{ content: string; attachments: unknown[] }> = [];
    adapter.onMessage((msg) => {
      messages.push({ content: msg.content, attachments: msg.attachments });
    });

    mockValidateToken();
    await adapter.connect();

    const port = adapter.port;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "BIZ_ID",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "+123", phone_number_id: "PHONE_ID" },
                contacts: [],
                messages: [
                  {
                    from: "987",
                    id: "wamid-img-001",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "image",
                    image: {
                      id: "IMG_ID",
                      mime_type: "image/jpeg",
                      sha256: "abc123",
                      caption: "Nice photo",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    await fetch(`http://127.0.0.1:${port}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Nice photo");
    expect(messages[0].attachments).toHaveLength(1);
    expect((messages[0].attachments[0] as { type: string }).type).toBe("image");

    await adapter.disconnect();
  });

  it("should handle location messages", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    const messages: Array<{ content: string }> = [];
    adapter.onMessage((msg) => { messages.push({ content: msg.content }); });

    mockValidateToken();
    await adapter.connect();

    const port = adapter.port;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "BIZ_ID",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "+123", phone_number_id: "PHONE_ID" },
                contacts: [],
                messages: [
                  {
                    from: "987",
                    id: "wamid-loc-001",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "location",
                    location: {
                      latitude: 37.7749,
                      longitude: -122.4194,
                      name: "San Francisco",
                      address: "SF, CA",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    await fetch(`http://127.0.0.1:${port}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("37.7749");
    expect(messages[0].content).toContain("San Francisco");

    await adapter.disconnect();
  });

  it("should handle reaction messages", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    const messages: Array<{ content: string }> = [];
    adapter.onMessage((msg) => { messages.push({ content: msg.content }); });

    mockValidateToken();
    await adapter.connect();

    const port = adapter.port;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "BIZ_ID",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "+123", phone_number_id: "PHONE_ID" },
                contacts: [],
                messages: [
                  {
                    from: "987",
                    id: "wamid-react-001",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "reaction",
                    reaction: { message_id: "wamid-original", emoji: "👍" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    await fetch(`http://127.0.0.1:${port}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("👍");

    await adapter.disconnect();
  });

  // ── Signature verification ─────────────────────────────────────────────────

  it("should reject requests with invalid signature when appSecret is set", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
      appSecret: "my-app-secret",
    });

    mockValidateToken();
    await adapter.connect();

    const port = adapter.port;
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    const resp = await fetch(`http://127.0.0.1:${port}/whatsapp/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=invalid",
      },
      body,
    });

    expect(resp.status).toBe(403);

    await adapter.disconnect();
  });

  it("should accept requests with valid signature when appSecret is set", async () => {
    const Adapter = await importAdapter();
    const secret = "my-app-secret";
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
      appSecret: secret,
    });

    mockValidateToken();
    await adapter.connect();

    const port = adapter.port;
    const body = Buffer.from(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "BIZ_ID",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: { display_phone_number: "+123", phone_number_id: "PHONE_ID" },
                  contacts: [],
                  messages: [
                    {
                      from: "987",
                      id: "wamid-sig-001",
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: "text",
                      text: { body: "Signed message" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    const signature = makeSignature(secret, body);

    const messages: Array<{ content: string }> = [];
    adapter.onMessage((msg) => { messages.push({ content: msg.content }); });

    const resp = await fetch(`http://127.0.0.1:${port}/whatsapp/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
      },
      body,
    });

    expect(resp.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toHaveLength(1);

    await adapter.disconnect();
  });

  // ── History filtering ──────────────────────────────────────────────────────

  it("should filter history by senderId", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    adapter.onMessage(() => {});
    mockValidateToken();
    await adapter.connect();

    const port = adapter.port;

    for (const [from, text] of [
      ["U1", "Message from U1"],
      ["U2", "Message from U2"],
      ["U1", "Another from U1"],
    ]) {
      const body = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "BIZ_ID",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: { display_phone_number: "+123", phone_number_id: "PHONE_ID" },
                  contacts: [],
                  messages: [
                    {
                      from,
                      id: `wamid-${from}-${text}`,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: "text",
                      text: { body: text },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      await fetch(`http://127.0.0.1:${port}/whatsapp/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const all = await adapter.getHistory();
    expect(all).toHaveLength(3);

    const filtered = await adapter.getHistory({ senderId: "U1" });
    expect(filtered).toHaveLength(2);

    await adapter.disconnect();
  });

  // ── Sent/received counts ───────────────────────────────────────────────────

  it("should track sent and received counts", async () => {
    const Adapter = await importAdapter();
    const adapter = new Adapter({
      accessToken: "token",
      phoneNumberId: "PHONE_ID",
      businessAccountId: "BIZ_ID",
      verifyToken: "verify",
    });

    adapter.onMessage(() => {});
    mockValidateToken();
    await adapter.connect();

    const port = adapter.port;

    // Receive a message
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "BIZ_ID",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "+123", phone_number_id: "PHONE_ID" },
                contacts: [],
                messages: [
                  {
                    from: "987",
                    id: "wamid-count-001",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Hello" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    await fetch(`http://127.0.0.1:${port}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Send a message
    mockSendMessageResponse();
    await adapter.sendMessage({ content: "Reply", channelOptions: { to: "+987" } });

    const status = adapter.getStatus();
    expect(status.sentCount).toBe(1);
    expect(status.receivedCount).toBe(1);

    await adapter.disconnect();
  });
});
