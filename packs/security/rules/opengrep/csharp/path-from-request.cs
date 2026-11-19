using System.IO;
using Microsoft.AspNetCore.Mvc;

public class FilesController : ControllerBase
{
    [HttpGet("files")]
    public IActionResult Get([FromQuery] string name)
    {
        // ruleid: factory.cs.path-from-request
        var text = System.IO.File.ReadAllText(Path.Combine("/srv/files", name));
        // ok: factory.cs.path-from-request
        var safe = System.IO.File.ReadAllText(Path.Combine("/srv/files", Path.GetFileName(name)));
        // ok: factory.cs.path-from-request
        var fixedText = System.IO.File.ReadAllText("/srv/files/index.txt");
        return Ok(text + safe + fixedText);
    }

    [HttpGet("download/{file}")]
    public IActionResult Download([FromRoute] string file)
    {
        // ruleid: factory.cs.path-from-request
        return PhysicalFile("/srv/files/" + file, "application/octet-stream");
    }
}
