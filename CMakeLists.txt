cmake_minimum_required(VERSION 3.25)
project(DailyFinanceIndiaLoanSimulator VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(dfi_app src/main.cpp)

if(MSVC)
    target_compile_options(dfi_app PRIVATE /W4 /permissive-)
else()
    target_compile_options(dfi_app PRIVATE -Wall -Wextra -Wpedantic)
endif()
