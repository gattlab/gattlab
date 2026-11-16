using Microsoft.JSInterop;

namespace GattLab.BlazorSample.Services;

public sealed class BluetoothService(IJSRuntime runtime, LifecycleLog log) : IAsyncDisposable
{
    private IJSObjectReference? module;
    private bool disposed;
    private Task? initialization;

    public Task InitializeAsync()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return initialization ??= InitializeCoreAsync();
    }

    private async Task InitializeCoreAsync()
    {
        module = await runtime.InvokeAsync<IJSObjectReference>("import", "./bluetooth.js");
    }

    public async Task<BluetoothSession> CreateSessionAsync()
    {
        await InitializeAsync();
        var session = new BluetoothSession(log, log.CreateSession());
        try
        {
            var reference = await module!.InvokeAsync<IJSObjectReference>(
                "createSession", session.Id, session.Receiver, log.Reference);
            session.Attach(reference);
            return session;
        }
        catch
        {
            await session.DisposeAsync();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        if (initialization is not null)
        {
            try
            {
                await initialization;
            }
            catch
            {
                // The initialization caller reports its primary error.
            }
        }
        if (module is not null) await module.DisposeAsync();
        module = null;
    }
}
