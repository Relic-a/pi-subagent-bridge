import { PiRpcClient } from "./pi-rpc-client.js";
export async function listModels(options, query) {
    const client = new PiRpcClient({
        executable: options.executable,
        args: options.rpcArgs,
    });
    const timer = setTimeout(() => client.terminate("SIGTERM"), options.timeoutMs);
    try {
        const response = await client.request(options.modelListMethod, query ? { query } : {});
        const models = normalizeModelResponse(response);
        const filtered = query ? filterModels(models, query) : models;
        return { models: filtered };
    }
    finally {
        clearTimeout(timer);
        client.terminate("SIGTERM");
    }
}
export function normalizeModelResponse(response) {
    const rawModels = Array.isArray(response)
        ? response
        : isRecord(response) && Array.isArray(response.models)
            ? response.models
            : undefined;
    if (!rawModels)
        throw new Error("Malformed Pi model-list response: expected an array or { models }.");
    return rawModels.map((item, index) => {
        if (!isRecord(item))
            throw new Error(`Malformed model at index ${index}: expected object.`);
        const provider = stringField(item, "provider", index);
        const modelId = stringField(item, "model_id", index, "id");
        return {
            provider,
            model_id: modelId,
            display_name: typeof item.display_name === "string"
                ? item.display_name
                : typeof item.name === "string"
                    ? item.name
                    : modelId,
            reasoning_support: Boolean(item.reasoning_support ??
                item.supports_reasoning ??
                item.reasoning ??
                false),
            context_window: nullableNumber(item.context_window ?? item.contextWindow),
            maximum_output_tokens: nullableNumber(item.maximum_output_tokens ?? item.max_output_tokens ?? item.maxTokens),
            supported_input_types: inputTypes(item),
        };
    });
}
function filterModels(models, query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0)
        return models;
    return models.filter((model) => {
        const haystack = [
            model.provider,
            model.model_id,
            model.display_name,
            model.reasoning_support ? "reasoning" : "",
            ...model.supported_input_types,
        ]
            .join(" ")
            .toLowerCase();
        return terms.every((term) => haystack.includes(term));
    });
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(item, field, index, fallback) {
    const value = item[field] ?? (fallback ? item[fallback] : undefined);
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Malformed model at index ${index}: missing ${field}.`);
    }
    return value;
}
function nullableNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function inputTypes(item) {
    const value = item.supported_input_types ?? item.input;
    return Array.isArray(value)
        ? value.filter((entry) => typeof entry === "string")
        : ["text"];
}
