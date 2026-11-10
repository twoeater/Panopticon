use anyhow::Result;
use serde::Deserialize;
use std::{io::{self, Read}, time::Duration};
use wasmtime::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{WasiCtxBuilder, FsPerms, p1::{self, WasiP1Ctx}, p2::pipe::{MemoryInputPipe, MemoryOutputPipe}};

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct Request { code: String, wasm_path: String, runtime_dir: String, timeout_ms: u64, memory_bytes: usize, output_bytes: usize }
struct State { wasi: WasiP1Ctx, limits: StoreLimits }
fn main() {
    if let Err(error) = execute() { println!("{}", serde_json::json!({"stdout":"","stderr":error.to_string(),"ok":false})); }
}
fn execute() -> Result<()> {
    let mut text=String::new(); io::stdin().take(200_000).read_to_string(&mut text)?;
    let req:Request=serde_json::from_str(&text)?;
    let mut config=Config::new(); config.epoch_interruption(true);
    let engine=Engine::new(&config).map_err(|e|anyhow::anyhow!("{e}"))?;
    let module=Module::from_file(&engine, &req.wasm_path).map_err(|e|anyhow::anyhow!("{e}"))?;
    let stdout=MemoryOutputPipe::new(req.output_bytes.min(1_048_576));
    let stderr=MemoryOutputPipe::new(req.output_bytes.min(1_048_576));
    let mut wasi=WasiCtxBuilder::new();
    wasi.stdin(MemoryInputPipe::new(Vec::<u8>::new())).stdout(stdout.clone()).stderr(stderr.clone());
    wasi.args(&["python", "-B", "-s", "-c", &req.code]);
    wasi.env("PYTHONHOME", "/python");
    wasi.preopened_dir(&req.runtime_dir, "/python", FsPerms::ReadOnly).map_err(|e|anyhow::anyhow!("{e}"))?;
    wasi.allow_tcp(false).allow_udp(false).allow_ip_name_lookup(false);
    let limits=StoreLimitsBuilder::new().memory_size(req.memory_bytes.min(1_073_741_824)).instances(1).build();
    let mut store=Store::new(&engine, State { wasi:wasi.build_p1(), limits });
    store.limiter(|state| &mut state.limits); store.set_epoch_deadline(1);
    let timer=engine.clone(); std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(req.timeout_ms.min(60_000))); timer.increment_epoch(); });
    let mut linker=Linker::new(&engine); p1::add_to_linker_sync(&mut linker, |s: &mut State| &mut s.wasi).map_err(|e|anyhow::anyhow!("{e}"))?;
    let instance=linker.instantiate(&mut store,&module).map_err(|e|anyhow::anyhow!("{e}"))?;
    let start=instance.get_typed_func::<(),()>(&mut store,"_start").map_err(|e|anyhow::anyhow!("{e}"))?;
    let outcome=start.call(&mut store,());
    let error=match outcome { Ok(())=>None, Err(e)=> if e.downcast_ref::<wasmtime_wasi::I32Exit>().is_some_and(|x| x.0==0) {None} else {Some(e.to_string())} };
    println!("{}",serde_json::json!({"stdout":String::from_utf8_lossy(&stdout.contents()),"stderr":String::from_utf8_lossy(&stderr.contents()),"ok":error.is_none(),"error":error}));
    Ok(())
}
