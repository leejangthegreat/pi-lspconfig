pub mod broken;

pub fn greet(name: &str) -> String {
    format!("Hello, {name}")
}

pub fn run() -> String {
    greet("world")
}
