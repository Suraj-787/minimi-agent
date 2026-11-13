# A11-no-over-application

- Category: memory-policy
- Clock: 2026-11-12T11:00:00+05:30 (Asia/Kolkata) · seed: yes
- Search: live (unused)
- Models: google · main `gemini-3.5-flash-lite` · small `gemini-3.5-flash-lite` · thinking tool low / answer low
- Ran: 2026-11-13 09:49 UTC
- Pass: 1/1

**Rubric:** Answers the question on its own merits. Does not bring up any past conversation or stored detail.

## Run 1 — PASS

**User:** What's a good way to structure a REST API error response?

**Assistant** (complete, first token 2.4 s, total 3.1 s):

> Use a standard JSON format like **RFC 7807 (Problem Details)**, which provides consistent fields for error identification and debugging.
> 
> A recommended structure:
> 
> ```json
> {
>   "type": "https://api.example.com/errors/invalid-parameter",
>   "title": "Invalid Request Parameter",
>   "status": 400,
>   "detail": "The 'email' field must be a valid email address.",
>   "instance": "/users/123/update",
>   "invalid_params": [
>     {
>       "name": "email",
>       "reason": "Malformed email format."
>     }
>   ]
> }
> ```
> 
> ### Key Fields
> * **`type`**: A URI identifying the error type (documentation link).
> * **`title`**: A short, human-readable summary of the problem.
> * **`status`**: The HTTP status code repeated in the body.
> * **`detail`**: A human-readable explanation specific to this occurrence.
> * **`instance`**: A URI identifying the specific occurrence of the problem.
> * **`invalid_params`** *(Optional)*: An array for detailed validation errors when multiple fields fail.

Steps:
- step 1 (auto): model 3081 ms, search 0 ms, finish stop, text 961 chars
  - auto: toolChoice auto, tools [web_search] → finish stop, text 961 chars

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

Judge: 5/5 — The answer accurately and comprehensively suggests a standard REST API error response structure using RFC 7807 without referencing any past conversations. [1.8 s]
