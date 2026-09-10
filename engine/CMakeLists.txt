cmake_minimum_required(VERSION 3.18)
project(FCNPilotEngine VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
option(IFCN_BUILD_TESTS "Build headless engine regressions" ON)
option(IFCN_BUILD_PYTHON_BINDINGS "Build the production parser and 2DDWave router" ON)

find_package(Boost REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(GRAPHVIZ REQUIRED IMPORTED_TARGET libgvc libcgraph)
find_package(Python3 3.11 REQUIRED COMPONENTS Interpreter)

add_library(autopr STATIC
  include/autopr/algorithms/astar.cpp
  include/autopr/algorithms/astarwithphase.cpp
  include/autopr/algorithms/mapping.cpp
  include/autopr/algorithms/phaseSolver.cpp
  include/autopr/algorithms/phase_codec.cpp
  include/autopr/graph/circuitGraph.cpp
  include/autopr/graph/legacyGraphvizRenderer.cpp
  include/autopr/graph/node.cpp
  include/autopr/graph/parse.cpp
  include/autopr/grid/grid.cpp
  include/autopr/grid/gridCell.cpp
  include/autopr/grid/patterns.cpp
  include/autopr/sequential/globalPhaseSolver.cpp
  include/autopr/sequential/physicalStateMacro.cpp
  include/autopr/sequential/sequentialIr.cpp
)
target_include_directories(autopr PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(autopr PUBLIC Boost::boost PkgConfig::GRAPHVIZ)
add_library(simon INTERFACE)
target_include_directories(simon INTERFACE "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(simon INTERFACE Boost::boost)

foreach(tool IN ITEMS combinational_pnr mapping_metrics energy_analysis physical_benchmark)
  add_executable(ifcn_${tool} src/app/ifcn_${tool}.cpp)
endforeach()
target_link_libraries(ifcn_combinational_pnr PRIVATE autopr)
add_executable(ifcn_layout_edit src/app/ifcn_layout_edit.cpp)
target_link_libraries(ifcn_layout_edit PRIVATE autopr)
target_link_libraries(ifcn_mapping_metrics PRIVATE autopr)
target_link_libraries(ifcn_energy_analysis PRIVATE autopr simon)
target_link_libraries(ifcn_physical_benchmark PRIVATE simon)

# Experimental sequential geometry retains distance-one feedback routes.
# A routed candidate does not constitute storage-device sign-off.
add_executable(ifcn_sequential_cyclic_pnr src/app/ifcn_sequential_cyclic_pnr.cpp)
target_link_libraries(ifcn_sequential_cyclic_pnr PRIVATE autopr)

# Regular-template genetic search is a separate headless backend.
add_library(ifcn_regular_search STATIC
  include/autopr/algorithms/genetic.cpp
  include/autopr/algorithms/individual.cpp)
target_link_libraries(ifcn_regular_search PUBLIC autopr)
add_executable(ifcn_regular_clock_pnr src/app/ifcn_regular_clock_pnr.cpp)
target_link_libraries(ifcn_regular_clock_pnr PRIVATE ifcn_regular_search)

if(IFCN_BUILD_PYTHON_BINDINGS)
  find_package(Python3 3.11 REQUIRED COMPONENTS Interpreter Development.Module)
  execute_process(COMMAND "${Python3_EXECUTABLE}" -m pybind11 --cmakedir
    OUTPUT_VARIABLE PYBIND11_CMAKE_DIR OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE PYBIND11_STATUS)
  if(PYBIND11_STATUS EQUAL 0)
    list(PREPEND CMAKE_PREFIX_PATH "${PYBIND11_CMAKE_DIR}")
  endif()
  set(PYBIND11_FINDPYTHON ON)
  find_package(pybind11 CONFIG REQUIRED)
  pybind11_add_module(iFCN_Lab NO_EXTRAS
    bindings/ifcn_bindings.cpp bindings/parse/Parse.cpp
    bindings/chessboard/MapPhaseAStar.cpp bindings/chessboard/RightDownAStar.cpp)
  target_include_directories(iFCN_Lab PRIVATE bindings/parse bindings/chessboard)
  target_link_libraries(iFCN_Lab PRIVATE Boost::boost)
  set_target_properties(iFCN_Lab PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/python")
endif()

if(IFCN_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()
