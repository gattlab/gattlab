using GattLab.BlazorSample;
using GattLab.BlazorSample.Services;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.Services.AddScoped<LifecycleLog>();
builder.Services.AddScoped<BluetoothService>();
await builder.Build().RunAsync();
