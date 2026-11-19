using System;
using System.Reflection;
using Microsoft.CodeAnalysis.CSharp.Scripting;

class Plugins
{
    async void Bad(string code, string typeName, byte[] blob)
    {
        // ruleid: factory.cs.dynamic-code
        var result = await CSharpScript.EvaluateAsync(code);
        // ruleid: factory.cs.dynamic-code
        var o = Activator.CreateInstance(Type.GetType(typeName));
        // ruleid: factory.cs.dynamic-code
        var asm = Assembly.Load(blob);
    }

    void Good()
    {
        // ok: factory.cs.dynamic-code
        var o = Activator.CreateInstance(Type.GetType("Shop.Discounts.Standard"));
        // ok: factory.cs.dynamic-code
        var a = Assembly.GetExecutingAssembly();
    }
}
