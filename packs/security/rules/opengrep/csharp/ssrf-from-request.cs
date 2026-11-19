using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

public class PreviewController : ControllerBase
{
    private readonly HttpClient _http = new HttpClient();

    [HttpPost("preview")]
    public async Task<IActionResult> Preview([FromBody] string url)
    {
        // ruleid: factory.cs.ssrf-from-request
        var page = await _http.GetStringAsync(url);
        // ok: factory.cs.ssrf-from-request
        var fixedPage = await _http.GetStringAsync("https://catalog.internal/items");
        return Ok(page + fixedPage);
    }
}
