using System.Diagnostics;

class Tools
{
    void Bad(string file, string tool)
    {
        // ruleid: factory.cs.process-from-input
        Process.Start(tool);
        // ruleid: factory.cs.process-from-input
        var psi = new ProcessStartInfo("convert", file + " out.png");
        // ruleid: factory.cs.process-from-input
        psi.Arguments = $"-resize 10 {file}";
    }

    void Good(string file)
    {
        // ok: factory.cs.process-from-input
        var psi = new ProcessStartInfo("convert");
        psi.ArgumentList.Add(file);
        // ok: factory.cs.process-from-input
        Process.Start(psi);
        // ok: factory.cs.process-from-input
        Process.Start("git");
    }
}
