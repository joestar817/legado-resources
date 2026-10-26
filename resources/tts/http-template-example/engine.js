// @name HTTP TTS 接口模板
// @schema 1
// @version 1.0.0
// @uuid ng_resource_example_http_template
// @author 阅读 NG 示例
// @enabled false
// @cookieJar false
// @audioType audio/mpeg
// @description 默认禁用的接口模板，需要自行填写兼容的 TTS 服务地址；不内置服务或凭据。

function options() {
    return [
        { key: "endpoint", label: "接口地址", type: "text", defaultValue: "" },
        { key: "voiceId", label: "发音人 ID", type: "text", defaultValue: "default" }
    ];
}

function voices(options, ctx) {
    return [{ id: "default", name: "接口声音（需配置）", language: "zh-CN" }];
}

function synthesize(text, voice, params, options, ctx) {
    var endpoint = String(options && options.endpoint || "").trim();
    if (!/^https?:\/\/[^\s]+$/.test(endpoint)) {
        throw new Error("请先配置兼容服务的 HTTP/HTTPS 接口地址");
    }
    return {
        url: endpoint,
        method: "POST",
        requestContentType: "application/json",
        audioContentType: "audio/mpeg",
        body: JSON.stringify({ text: String(text), voice: String(options.voiceId || "default") }),
        timeout: 30,
        retry: 0
    };
}
