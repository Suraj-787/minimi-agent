# A11-no-over-application

- Category: memory-policy
- Clock: 2026-11-12T11:00:00+05:30 (Asia/Kolkata) · seed: yes
- Search: live
- Models: google · main `gemini-3.5-flash-lite` · small `gemini-3.5-flash-lite` · thinking tool low / answer low
- Ran: 2026-11-12 15:47 UTC
- Pass: 1/1

**Rubric:** Answers the question on its own merits. Does not bring up any past conversation or stored detail.

## Run 1 — PASS

**User:** What's a good way to structure a REST API error response?

Searches: `RFC 7807 problem details for http APIs`

**Assistant** (complete, first token 8.2 s, total 9.2 s):

> Use the industry-standard **RFC 9457 (Problem Details for HTTP APIs)** format, which uses the `application/problem+json` content type [7, 8]. 
> 
> A standard structure includes these fields:
> 
> ```json
> {
>   "type": "https://api.example.com/errors/out-of-credit",
>   "title": "You do not have enough credit",
>   "status": 403,
>   "detail": "Your current balance is 30, but this action requires 50.",
>   "instance": "/account/12345/transactions/abc-987",
>   "code": "INSUFFICIENT_CREDIT",
>   "errors": [
>     {
>       "field": "amount",
>       "message": "Field must be greater than zero"
>     }
>   ]
> }
> ```
> 
> ### Key Fields
> * **`type`**: A URI identifying the error category [4]. Can point to documentation.
> * **`title`**: A short, human-readable summary of the error type that doesn't change per occurrence.
> * **`status`**: The HTTP status code repeated in the body for logging safety [3, 7].
> * **`detail`**: A human-readable explanation specific to this occurrence [4].
> * **`instance`**: A URI identifying the specific occurrence of the problem, useful for tracing logs [3].
> * **`code`** *(custom extension)*: A machine-readable string code (e.g., `USER_NOT_FOUND`) for client-side conditional logic.
> * **`errors`** *(custom extension)*: An array used primarily for validation failures, mapping specific fields to issues.

Sources returned:
- [1] An introduction to RFC 7807 | Representing Problem Details in HTTP APIs — https://blog.axway.com/learning-center/apis/api-design/introduction-to-rfc-7807 — 2022-06-14
- [2] RFC 7807: Problem Details for HTTP APIs | RFC Editor — https://www.rfc-editor.org/info/rfc7807/ — 2016-03-31
- [3] https://www.rfc-editor.org/rfc/rfc7807.html — https://www.rfc-editor.org/rfc/rfc7807.html — undated
- [4] A Deep Dive into RFC 7807 and RFC 9457 — https://www.codecentric.de/en/knowledge-hub/blog/charge-your-apis-volume-19-understanding-problem-details-for-http-apis-a-deep-dive-into-rfc-7807-and-rfc-9457 — 2023-11-30
- [5] Problem Details - A Standardized Structure For API Errors — https://problemdetails.com/ — undated
- [6] Problem Details for HTTP APIs - RFC 7807 is dead, long ... — https://blog.frankel.ch/problem-details-http-apis/ — 2023-09-10
- [7] RFC 9457: Problem Details for HTTP APIs — https://www.rfc-editor.org/rfc/rfc9457.html — undated
- [8] src/content/posts/http-api-problem-details.mdx at main · httptoolkit/httptoolkit-website — https://github.com/httptoolkit/httptoolkit-website/blob/main/src/content/posts/http-api-problem-details.mdx — undated

Steps:
- step 1 (auto): model 1314 ms, search 1296 ms, finish tool-calls, text 0 chars
  - auto: toolChoice auto, tools [web_search] → finish tool-calls, text 0 chars, tool calls: web_search({"queries":["RFC 7807 problem details for http APIs"]})
- step 2 (auto): model 6571 ms, search 0 ms, finish stop, text 1303 chars
  - auto: toolChoice auto, tools [web_search] → finish stop, text 1303 chars

Checks:
- ✓ answerComplete
- ✓ mustNotMention "CRM"
- ✓ mustNotMention "Postgres"
- ✓ mustNotMention "Neon"
- ✓ mustNotMention "Bun"
- ✓ mustNotMention "half marathon"
- ✓ mustNotMention "you asked"
- ✓ recallRules
- ✓ memoryInjected

Judge: 5/5 — The assistant provides a clear and standard-compliant recommendation for REST API error responses (RFC 9457), follows the rubric completely, and avoids any unauthorized past-conversation references.
